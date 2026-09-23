import type { AnalysisRequest, EngineAdapter, EngineDescriptor, EngineEvent } from '@chessin/core/engine';
import { UciSession, type UciTransport } from '@chessin/core/uci';
import { assetBase, engineVersion, hardwareThreads, profiles, type EngineProfile } from './engine-assets';

function workerTransport(worker: Worker): UciTransport {
  const queued: string[] = [];
  let waiter: ((result: IteratorResult<string>) => void) | undefined;
  let closed = false;
  const push = (line: string) => {
    if (closed) return;
    if (waiter) { const resolve = waiter; waiter = undefined; resolve({ value: line, done: false }); }
    else queued.push(line);
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    worker.terminate();
    waiter?.({ value: undefined, done: true });
    waiter = undefined;
  };
  worker.addEventListener('message', event => push(`${String(event.data)}\n`));
  worker.addEventListener('error', stop);
  worker.addEventListener('messageerror', stop);
  return {
    write(command) { if (closed) throw new Error('Engine disconnected'); worker.postMessage(command); },
    output: {
      async *[Symbol.asyncIterator]() {
        while (!closed || queued.length) {
          if (queued.length) { yield queued.shift()!; continue; }
          const result = await new Promise<IteratorResult<string>>(resolve => { waiter = resolve; });
          if (result.done) break;
          yield result.value;
        }
      },
    },
    dispose: stop,
  };
}

export class LocalEngine implements EngineAdapter {
  private session?: UciSession;
  private initializing?: Promise<EngineDescriptor>;
  constructor(readonly profile: EngineProfile) {}
  async initialize(): Promise<EngineDescriptor> {
    if (!this.initializing) this.initializing = (async () => {
      const [script] = profiles[this.profile];
      const worker = new Worker(assetBase + script); // Stockfish release scripts are classic workers.
      this.session = new UciSession(workerTransport(worker), this.profile, engineVersion, {
        maxThreads: hardwareThreads(this.profile), maxHashMb: 256, maxMultiPv: 5,
      });
      return this.session.initialize();
    })().catch(async error => {
      await this.dispose();
      throw new Error(error instanceof Error && /timed out/i.test(error.message)
        ? 'Local engine timed out. Retry, or switch to lite-single.'
        : 'Local engine failed to start. Retry or switch to lite-single.');
    });
    return this.initializing;
  }
  async *analyze(request: AnalysisRequest, signal: AbortSignal): AsyncIterable<EngineEvent> {
    await this.initialize();
    yield* this.session!.analyze(request, signal);
  }
  newGame(): void { this.session?.newGame(); }
  async dispose(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.initializing = undefined;
    await session?.dispose();
  }
}
