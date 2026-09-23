import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AnalysisRequest, EngineEvent, ResourceCaps } from '@chessin/core/engine';
import { analysisRequestSchema, validateAnalysisRequest } from '@chessin/core/protocol';
import type { UciSession } from '@chessin/core/uci';
import type { PreparedEngine } from '../engine-process.js';
import { openEngine } from '../engine-process.js';
import type { ServerConfig } from '../config.js';

interface ActiveJob { cancel: AbortController; finished: Promise<void> }
export interface AnalysisRuntime {
  config: ServerConfig;
  catalog: Map<string, PreparedEngine>;
  jobs: Set<ActiveJob>;
}
const responseError = (code: string, message: string) => ({ error: { code, message } });

async function writeEvent(stream: PassThrough, event: EngineEvent): Promise<void> {
  const record = `${JSON.stringify(event)}\n`;
  if (stream.destroyed || stream.writableLength + Buffer.byteLength(record) > 256 * 1024) throw new Error('SLOW_CONSUMER');
  if (stream.write(record)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('SLOW_CONSUMER')); }, 5000);
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(new Error('REMOTE_DISCONNECTED')); };
    const cleanup = () => { clearTimeout(timer); stream.off('drain', drain); stream.off('close', close); };
    stream.once('drain', drain);
    stream.once('close', close);
  });
}

/** At most ten network flushes/second. Distinct completed depth/PV snapshots remain distinct. */
async function pump(session: UciSession, request: AnalysisRequest, signal: AbortSignal, stream: PassThrough, deadline: { expired: boolean }): Promise<'completed' | 'limit' | 'failed'> {
  const pending = new Map<string, Extract<EngineEvent, { type: 'info' }>>();
  let lastFlush = Date.now();
  const flush = async () => {
    for (const info of pending.values()) await writeEvent(stream, info);
    pending.clear();
    lastFlush = Date.now();
  };
  for await (const event of session.analyze(request, signal)) {
    if (stream.destroyed) break;
    if (event.type === 'info') {
      const key = `${event.depth}:${event.multiPv}`;
      const previous = pending.get(key);
      if (!previous || (event.score && event.pv.length) || (!previous.score && !previous.pv.length)) pending.set(key, event);
      if (Date.now() - lastFlush >= 100) await flush();
      continue;
    }
    await flush();
    if (event.type === 'bestmove' && signal.aborted) continue;
    if (event.type === 'done') {
      await writeEvent(stream, { ...event, reason: deadline.expired ? 'limit' : event.reason });
      return deadline.expired ? 'limit' : 'completed';
    }
    await writeEvent(stream, event);
    if (event.type === 'error') return 'failed';
  }
  if (!signal.aborted && !stream.destroyed) throw new Error('ENGINE_CRASHED');
  return deadline.expired ? 'limit' : 'completed';
}

export function registerAnalysis(app: FastifyInstance, runtime: AnalysisRuntime): void {
  const caps: ResourceCaps = { maxThreads: runtime.config.maxThreads, maxHashMb: runtime.config.maxHashMb, maxMultiPv: runtime.config.maxMultiPv };
  app.post('/v1/analyze', { schema: { body: analysisRequestSchema }, bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) return reply.code(415).send(responseError('UNSUPPORTED_MEDIA_TYPE', 'Send a JSON analysis request.'));
    const input = request.body as AnalysisRequest;
    const entry = runtime.catalog.get(input.engineId);
    if (!entry) return reply.code(404).send(responseError('ENGINE_NOT_FOUND', 'Select an available engine.'));
    let chess;
    try { chess = validateAnalysisRequest(input, entry.descriptor, caps); }
    catch { return reply.code(400).send(responseError('INVALID_REQUEST', 'Invalid position, move history, settings or search limits.')); }
    if (chess.isGameOver()) {
      const stream = new PassThrough();
      stream.end(`${JSON.stringify({ type: 'bestmove', requestId: input.requestId, move: null })}\n${JSON.stringify({ type: 'done', requestId: input.requestId, reason: 'completed' })}\n`);
      return reply.headers({ 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }).type('application/x-ndjson; charset=utf-8').send(stream);
    }
    if (runtime.jobs.size >= runtime.config.maxConcurrent) return reply.header('Retry-After', '1').code(429).send(responseError('ENGINE_BUSY', 'Engine capacity is busy. Retry shortly.'));

    const cancel = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const job: ActiveJob = { cancel, finished };
    runtime.jobs.add(job);
    const deadline = { expired: false };
    const timer = setTimeout(() => { deadline.expired = true; cancel.abort(); }, runtime.config.maxJobMs);
    let session: UciSession | undefined;
    let stream: PassThrough | undefined;
    const startedAt = Date.now();
    let status = 'completed';
    const disconnected = () => { if (!stream?.writableEnded) { status = 'disconnected'; cancel.abort(); stream?.destroy(); } };
    request.raw.once('aborted', disconnected);
    reply.raw.once('close', disconnected);
    try {
      session = await openEngine(entry, caps, cancel.signal);
      if (cancel.signal.aborted) throw new Error('Job interrupted before startup');
      stream = new PassThrough({ highWaterMark: 16 * 1024 });
      const output = stream;
      const engine = session;
      void (async () => {
        try {
          const result = await pump(engine, input, cancel.signal, output, deadline);
          if (status !== 'disconnected') status = result;
        } catch (error) {
          const slow = error instanceof Error && error.message === 'SLOW_CONSUMER';
          status = deadline.expired ? 'limit' : slow ? 'slow-consumer' : 'failed';
          if (slow) output.destroy();
          else if (!output.destroyed && !cancel.signal.aborted) {
            try { await writeEvent(output, { type: 'error', requestId: input.requestId, code: 'ENGINE_CRASHED', message: 'The engine stopped unexpectedly. Retry.' }); }
            catch { output.destroy(); }
          }
        } finally {
          cancel.abort();
          clearTimeout(timer);
          if (!output.destroyed) output.end();
          await engine.dispose();
          runtime.jobs.delete(job);
          finish();
          request.log.info({ requestId: input.requestId, engineId: input.engineId, durationMs: Date.now() - startedAt, status }, 'analysis finished');
        }
      })();
      return reply.headers({ 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }).type('application/x-ndjson; charset=utf-8').send(output);
    } catch {
      status = deadline.expired ? 'limit' : 'unavailable';
      cancel.abort();
      clearTimeout(timer);
      await session?.dispose();
      runtime.jobs.delete(job);
      finish();
      request.log.info({ requestId: input.requestId, engineId: input.engineId, durationMs: Date.now() - startedAt, status }, 'analysis startup failed');
      return reply.code(503).send(responseError('ENGINE_UNAVAILABLE', 'The engine could not start. Retry or select another engine.'));
    } finally {
      request.raw.off('aborted', disconnected);
      // reply.raw close remains installed until the stream closes, including client disconnects.
    }
  });
}
