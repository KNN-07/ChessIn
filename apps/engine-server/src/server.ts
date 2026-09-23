import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { protocolVersion } from '@chessin/core/protocol';
import type { ResourceCaps } from '@chessin/core/engine';
import { authorized, loadConfig, type ServerConfig } from './config.js';
import { probeEngine, type PreparedEngine } from './engine-process.js';
import { registerAnalysis, type AnalysisRuntime } from './routes/analysis.js';

export async function buildServer(config?: ServerConfig): Promise<FastifyInstance> {
  const settings = config ?? await loadConfig();
  const caps: ResourceCaps = { maxThreads: settings.maxThreads, maxHashMb: settings.maxHashMb, maxMultiPv: settings.maxMultiPv };
  const catalog = new Map<string, PreparedEngine>();
  for (const engine of settings.engines) catalog.set(engine.id, await probeEngine(engine, caps));
  const app = Fastify({
    bodyLimit: 64 * 1024, requestTimeout: 10000,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
    logger: { redact: { paths: ['req.headers.authorization', 'headers.authorization', 'request.headers.authorization'], censor: '[REDACTED]' } },
  });
  const runtime: AnalysisRuntime = { config: settings, catalog, jobs: new Set() };
  let closing = false;
  app.addHook('onRequest', async (request, reply) => {
    if (closing) return reply.code(503).send({ error: { code: 'ENGINE_UNAVAILABLE', message: 'The server is shutting down.' } });
    const origin = request.headers.origin;
    if (origin && !settings.allowedOrigins.has(origin)) return reply.code(403).send({ error: { code: 'ORIGIN_FORBIDDEN', message: 'This origin is not allowed.' } });
    if (request.method === 'OPTIONS' && origin) return;
    if (request.method === 'GET' && request.url.split('?')[0] === '/healthz') return;
    if (!authorized(request.headers.authorization, settings.tokenHash)) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' } });
    if (request.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use application/json.' } });
    }
  });
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || settings.allowedOrigins.has(origin)),
    methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false, strictPreflight: true,
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = statusCode === 413 ? 413 : statusCode === 415 ? 415 : statusCode === 400 ? 400 : 503;
    const code = status === 413 ? 'REQUEST_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : status === 503 ? 'ENGINE_UNAVAILABLE' : 'INVALID_REQUEST';
    if (status === 503) request.log.error({ code: 'ENGINE_UNAVAILABLE' }, 'request failed');
    void reply.code(status).send({ error: { code, message: status === 413 ? 'The request exceeds 64 KiB.' : status === 415 ? 'Use application/json.' : status === 503 ? 'The engine service is unavailable.' : 'Invalid analysis request.' } });
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/v1/engines', async () => ({
    protocolVersion,
    engines: [...catalog.values()].map(entry => entry.descriptor),
    limits: { maxConcurrent: settings.maxConcurrent, maxJobMs: settings.maxJobMs, maxThreads: settings.maxThreads, maxHashMb: settings.maxHashMb, maxMultiPv: settings.maxMultiPv },
  }));
  registerAnalysis(app, runtime);
  app.addHook('preClose', async () => { closing = true; for (const job of runtime.jobs) job.cancel.abort(); });
  app.addHook('onClose', async () => { await Promise.all([...runtime.jobs].map(job => job.finished)); });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = await loadConfig();
    const app = await buildServer(config);
    const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Engine server startup failed');
    process.exitCode = 1;
  }
}
