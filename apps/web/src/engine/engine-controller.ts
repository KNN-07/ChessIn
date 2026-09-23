import type { AnalysisRequest, EngineAdapter, EngineEvent } from '@chessin/core/engine';
import { LocalEngine } from './local-engine';

export type EngineOwner = 'analysis' | 'review' | 'play';
export class EngineController {
  private adapter: EngineAdapter | null = null;
  private active?: { owner: EngineOwner; abort: AbortController };
  private tail: Promise<void> = Promise.resolve();
  private playActive = false;
  private reviewActive = false;
  onFailure?: (message: string) => void;
  private gameId?: string;
  private generation = 0;
  constructor() {
    document.addEventListener('visibilitychange', this.visibility);
  }
  private visibility = () => {
    if (document.hidden && this.active?.owner !== 'play') this.active?.abort.abort();
  };
  async use(adapter: EngineAdapter | null): Promise<void> {
    this.cancel();
    this.generation++;
    const previous = this.adapter;
    this.adapter = adapter;
    this.gameId = undefined;
    if (previous && previous !== adapter) await previous.dispose();
  }
  setPlayActive(active: boolean): void {
    this.playActive = active;
    if (active && this.active?.owner !== 'play') this.cancel();
  }
  isPlayActive(): boolean { return this.playActive; }
  setReviewActive(active: boolean): void { this.reviewActive = active; }
  isBusy(): boolean { return this.playActive || this.reviewActive || !!this.active; }
  hasAdapter(): boolean { return this.adapter !== null; }
  cancel(owner?: EngineOwner): void {
    if (!owner || this.active?.owner === owner) this.active?.abort.abort();
  }
  newGame(gameId: string): void {
    if (gameId === this.gameId) return;
    this.gameId = gameId;
    if (this.adapter instanceof LocalEngine) this.adapter.newGame();
  }
  async *search(owner: EngineOwner, request: AnalysisRequest, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    const adapter = this.adapter;
    if (!adapter) throw new Error('Choose and initialize an engine before searching.');
    if (owner !== 'play' && this.playActive) throw new Error('Suspend the active game before analyzing.');
    if (owner !== 'play' && document.hidden) throw new Error('Return to the app to resume analysis.');
    this.cancel();
    const generation = this.generation;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    this.active = { owner, abort };
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await predecessor; // Wait for stopped bestmove and UCI readiness fence before a replacement.
      if (abort.signal.aborted || this.generation !== generation) {
        yield { type: 'done', requestId: request.requestId, reason: 'cancelled' };
        return;
      }
      for await (const event of adapter.analyze(request, abort.signal)) {
        if (abort.signal.aborted || this.generation !== generation) {
          if (event.type === 'done' || event.type === 'error') break;
          continue;
        }
        if (event.requestId !== request.requestId) continue;
        if (event.type === 'error') {
          this.onFailure?.(event.message);
          this.adapter = null;
          await adapter.dispose();
        }
        yield event;
      }
      if (abort.signal.aborted) yield { type: 'done', requestId: request.requestId, reason: 'cancelled' };
    } finally {
      abort.abort();
      signal?.removeEventListener('abort', cancel);
      if (this.active?.abort === abort) this.active = undefined;
      release();
    }
  }
  async dispose(): Promise<void> {
    this.cancel();
    document.removeEventListener('visibilitychange', this.visibility);
    await this.use(null);
  }
}
