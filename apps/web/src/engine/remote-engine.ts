import type { AnalysisRequest, EngineAdapter, EngineDescriptor, EngineEvent, ResourceCaps } from '@chessin/core/engine';
import { validateAnalysisRequest } from '@chessin/core/protocol';

export function normalizeEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('Enter an HTTPS server URL without credentials, query or fragment.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote engines require HTTPS except on this device’s localhost.');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Enter the server origin only, without a path.');
  return url.origin;
}

const failureMessages: Record<string, string> = {
  ENGINE_START_FAILED: 'Remote engine could not start. Check server availability.',
  ENGINE_TIMEOUT: 'Remote engine timed out. Retry with a smaller search limit.',
  ENGINE_CRASHED: 'Remote engine stopped unexpectedly. Reconnect or switch to local.',
  INVALID_ENGINE_OUTPUT: 'Remote engine returned invalid output. Check server configuration.',
  SLOW_CONSUMER: 'Remote stream stalled. Retry with a shorter search.',
  REMOTE_DISCONNECTED: 'Remote analysis disconnected. Reconnect or switch to local.',
};
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parseEvent(value: unknown, requestId: string): EngineEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote engine event');
  const data = value as Record<string, unknown>;
  if (data.requestId !== requestId) throw new Error('Unexpected remote request ID');
  if (data.type === 'started') return { type: 'started', requestId };
  if (data.type === 'info') {
    if (!numeric(data.depth) || !Number.isInteger(data.depth) || !numeric(data.multiPv) || !Number.isInteger(data.multiPv) || data.multiPv < 1 ||
      !Array.isArray(data.pv) || !data.pv.every(move => typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) throw new Error('Invalid remote engine info');
    const score = data.score as { kind?: unknown; value?: unknown; bound?: unknown } | undefined;
    if (score && (!['cp', 'mate'].includes(String(score.kind)) || typeof score.value !== 'number' || !Number.isInteger(score.value) ||
      (score.bound !== undefined && !['lower', 'upper'].includes(String(score.bound))))) throw new Error('Invalid remote engine score');
    for (const field of ['nodes', 'nps', 'timeMs', 'hashfull']) if (data[field] !== undefined && !numeric(data[field])) throw new Error('Invalid remote engine info');
    return data as unknown as EngineEvent;
  }
  if (data.type === 'bestmove' && (data.move === null || typeof data.move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(data.move)) &&
      (data.ponder === undefined || typeof data.ponder === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(data.ponder))) return data as unknown as EngineEvent;
  if (data.type === 'done' && ['completed', 'cancelled', 'limit'].includes(String(data.reason))) return data as unknown as EngineEvent;
  if (data.type === 'error' && Object.hasOwn(failureMessages, String(data.code)) && typeof data.message === 'string') return { type: 'error', requestId, code: data.code as Extract<EngineEvent, {type:'error'}>['code'], message: failureMessages[String(data.code)] };
  throw new Error('Invalid remote engine event');
}

export class RemoteEngine implements EngineAdapter {
  private active = new Set<AbortController>();
  private constructor(readonly endpoint: string, private token: string, readonly descriptor: EngineDescriptor, readonly caps: ResourceCaps) {}

  static async discover(endpointInput: string, token: string): Promise<{ endpoint: string; engines: EngineDescriptor[]; limits: ResourceCaps }> {
    const endpoint = normalizeEndpoint(endpointInput);
    if (!token.trim()) throw new Error('Enter the server bearer token.');
    let response: Response;
    try { response = await fetch(`${endpoint}/v1/engines`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store' }); }
    catch { throw new Error('Remote server unreachable. Check HTTPS and network access.'); }
    if (!response.ok) throw new Error(response.status === 401 ? 'Token rejected by the remote server.' : `Remote server refused connection (HTTP ${response.status}).`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') throw new Error('Remote engine catalog is invalid.');
    const catalog = data as { protocolVersion?: unknown; engines?: unknown; limits?: unknown };
    if (catalog.protocolVersion !== 1 || !Array.isArray(catalog.engines) || !catalog.engines.length || !catalog.engines.every(item =>
      item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.author === 'string' &&
      typeof item.buildVersion === 'string' && Array.isArray(item.options))) throw new Error('Remote protocol or engine catalog is incompatible.');
    const limits = catalog.limits as ResourceCaps;
    if (!limits || !numeric(limits.maxThreads) || !numeric(limits.maxHashMb) || !numeric(limits.maxMultiPv)) throw new Error('Remote resource limits are invalid.');
    const engines = catalog.engines as EngineDescriptor[];
    return { endpoint, engines, limits };
  }
  static async connect(endpointInput: string, token: string, engineId: string): Promise<{ adapter: RemoteEngine; engines: EngineDescriptor[]; limits: ResourceCaps }> {
    const { endpoint, engines, limits } = await RemoteEngine.discover(endpointInput, token);
    const descriptor = engines.find(engine => engine.id === engineId);
    if (!descriptor) throw new Error('Select an engine offered by this server.');
    return { adapter: new RemoteEngine(endpoint, token, descriptor, limits), engines, limits };
  }
  async initialize(): Promise<EngineDescriptor> { return this.descriptor; }
  async *analyze(request: AnalysisRequest, signal: AbortSignal): AsyncIterable<EngineEvent> {
    validateAnalysisRequest(request, this.descriptor, this.caps);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    this.active.add(controller);
    let terminal = false;
    try {
      const response = await fetch(`${this.endpoint}/v1/analyze`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request), signal: controller.signal, redirect: 'error', cache: 'no-store',
      });
      if (!response.ok) {
        let message = `Remote server rejected analysis (HTTP ${response.status}).`;
        if (response.status === 401) message = 'Remote token was rejected. Reconnect with a valid token.';
        if (response.status === 429) message = 'Remote engine is busy. Retry shortly.';
        if (response.status === 400) message = 'Remote server rejected the position or settings. Check engine controls.';
        throw new Error(message);
      }
      if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) throw new Error('Remote server did not stream engine events.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let fragment = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          fragment += decoder.decode(value, { stream: !done });
          if (fragment.length > 262144) throw new Error('Remote engine event is too large.');
          let newline: number;
          while ((newline = fragment.indexOf('\n')) !== -1) {
            const line = fragment.slice(0, newline).trim();
            fragment = fragment.slice(newline + 1);
            if (!line) continue;
            if (line.length > 65536 || terminal) throw new Error('Invalid remote engine stream.');
            const event = parseEvent(JSON.parse(line), request.requestId);
            if (event.type === 'done' || event.type === 'error') terminal = true;
            yield event;
          }
          if (done) break;
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (fragment.trim() || !terminal) throw new Error('Remote engine connection ended before completion.');
    } catch (error) {
      if (signal.aborted) { yield { type: 'done', requestId: request.requestId, reason: 'cancelled' }; return; }
      const message = error instanceof Error ? error.message : '';
      const invalid = error instanceof SyntaxError || /^(Invalid |Unexpected |Remote engine event is too large)/.test(message);
      yield { type: 'error', requestId: request.requestId, code: invalid ? 'INVALID_ENGINE_OUTPUT' : 'REMOTE_DISCONNECTED',
        message: invalid ? failureMessages.INVALID_ENGINE_OUTPUT : message.startsWith('Remote ') ? message : failureMessages.REMOTE_DISCONNECTED };
    } finally {
      this.active.delete(controller);
      signal.removeEventListener('abort', abort);
      controller.abort();
    }
  }
  async dispose(): Promise<void> {
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.token = '';
  }
}
