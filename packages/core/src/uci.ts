import type { AnalysisRequest, EngineDescriptor, EngineEvent, EngineSettings, ResourceCaps, UciOption } from './engine.js';
import { uciMovePattern, supportedSettings, validateAnalysisRequest } from './protocol.js';

const HANDSHAKE_MS = 15000;
const STOP_MS = 2000;
const MAX_LINE = 65536;
const safeOptionTypes: Record<string, UciOption['type']> = {
  threads: 'spin', hash: 'spin', multipv: 'spin', 'skill level': 'spin',
  uci_limitstrength: 'check', uci_elo: 'spin', 'clear hash': 'button',
};

/** write receives a complete UCI command without a newline; output yields arbitrary stdout chunks. */
export interface UciTransport {
  write(command: string): void | Promise<void>;
  output: AsyncIterable<string>;
  dispose(): void | Promise<void>;
}

export function parseUciOption(line: string): UciOption | undefined {
  if (!line.startsWith('option name ')) return undefined;
  const fields = line.slice(12).split(/\s+(?=type |default |min |max |var )/);
  const name = fields.shift()?.trim();
  const values: Record<string, string[]> = {};
  for (const field of fields) {
    const divider = field.indexOf(' ');
    if (divider < 0) return undefined;
    (values[field.slice(0, divider)] ??= []).push(field.slice(divider + 1).trim());
  }
  const type = values.type?.[0];
  if (!name || !type || !['spin', 'check', 'combo', 'button', 'string'].includes(type) || /[\x00-\x1f\x7f]/.test(name)) return undefined;
  const result: UciOption = { name, type: type as UciOption['type'] };
  if (values.default?.[0] !== undefined && values.default[0] !== '<empty>') {
    const raw = values.default[0];
    result.default = type === 'spin' && /^-?\d+$/.test(raw) ? Number(raw) : type === 'check' && /^(true|false)$/.test(raw) ? raw === 'true' : raw;
  }
  for (const key of ['min', 'max'] as const) {
    const raw = values[key]?.[0];
    if (raw !== undefined && /^-?\d+$/.test(raw)) result[key] = Number(raw);
  }
  if (values.var) result.vars = values.var;
  return result;
}

export function parseInfo(line: string, requestId: string): Extract<EngineEvent, { type: 'info' }> | undefined {
  if (!line.startsWith('info ')) return undefined;
  const tokens = line.trim().split(/\s+/);
  const event: Extract<EngineEvent, { type: 'info' }> = { type: 'info', requestId, depth: 0, multiPv: 1, pv: [] };
  for (let i = 1; i < tokens.length;) {
    const field = tokens[i++];
    if (field === 'score') {
      const kind = tokens[i++], raw = tokens[i++];
      if ((kind === 'cp' || kind === 'mate') && /^-?\d+$/.test(raw ?? '') && Number.isSafeInteger(Number(raw))) {
        event.score = { kind, value: Number(raw) };
        if (tokens[i] === 'lowerbound' || tokens[i] === 'upperbound') event.score.bound = tokens[i++] === 'lowerbound' ? 'lower' : 'upper';
      }
    } else if (field === 'pv') {
      while (i < tokens.length && uciMovePattern.test(tokens[i])) event.pv.push(tokens[i++]);
    } else if (field === 'depth' || field === 'multipv' || field === 'nodes' || field === 'nps' || field === 'time' || field === 'hashfull') {
      const raw = tokens[i++];
      if (!/^\d+$/.test(raw ?? '')) continue;
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) continue;
      if (field === 'depth') event.depth = value;
      else if (field === 'multipv') event.multiPv = value;
      else if (field === 'nodes') event.nodes = value;
      else if (field === 'nps') event.nps = value;
      else if (field === 'time') event.timeMs = value;
      else event.hashfull = value;
    } else if (field === 'string' || field === 'refutation' || field === 'currline') break;
  }
  return event.depth > 0 && event.multiPv > 0 ? event : undefined;
}

export function positionCommand(position: AnalysisRequest['position']): string {
  if (typeof position.initialFen !== 'string' || position.initialFen.length < 1 || position.initialFen.length > 256 || /[\x00-\x1f\x7f]/.test(position.initialFen) || !Array.isArray(position.moves) || position.moves.length > 2048 || !position.moves.every(move => typeof move === 'string' && uciMovePattern.test(move))) throw new Error('Invalid UCI position');
  return `position fen ${position.initialFen}${position.moves.length ? ` moves ${position.moves.join(' ')}` : ''}`;
}

function uciInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error('Invalid UCI search limit');
  return value;
}

export function goCommand(request: AnalysisRequest): string {
  const limit = request.limit;
  let command: string;
  if (limit.kind === 'infinite') command = 'go infinite';
  else if (limit.kind === 'clock') {
    command = `go wtime ${uciInteger(limit.whiteMs, 0, 86400000)} btime ${uciInteger(limit.blackMs, 0, 86400000)} winc ${uciInteger(limit.whiteIncrementMs, 0, 60000)} binc ${uciInteger(limit.blackIncrementMs, 0, 60000)}`;
  } else if (limit.kind === 'bounded') {
    if (limit.depth === undefined && limit.moveTimeMs === undefined && limit.nodes === undefined) throw new Error('Missing bounded search limit');
    command = `go${limit.depth === undefined ? '' : ` depth ${uciInteger(limit.depth, 1, 60)}`}${limit.moveTimeMs === undefined ? '' : ` movetime ${uciInteger(limit.moveTimeMs, 100, 300000)}`}${limit.nodes === undefined ? '' : ` nodes ${uciInteger(limit.nodes, 1000, 1000000000)}`}`;
  } else throw new Error('Invalid UCI search limit');
  if (request.searchMoves !== undefined) {
    if (!Array.isArray(request.searchMoves) || !request.searchMoves.length || request.searchMoves.length > 218 || !request.searchMoves.every(move => typeof move === 'string' && uciMovePattern.test(move))) throw new Error('Invalid restricted moves');
    command += ` searchmoves ${request.searchMoves.join(' ')}`;
  }
  return command;
}

/** Only the five explicitly supported UCI controls can be sent from client settings. */
export function settingsCommands(settings: EngineSettings, descriptor: EngineDescriptor, caps?: ResourceCaps): string[] {
  supportedSettings(settings, descriptor, caps);
  const limitStrength = descriptor.options.some(option => option.name.toLowerCase() === 'uci_limitstrength' && option.type === 'check');
  const skillLevel = descriptor.options.find(option => option.name.toLowerCase() === 'skill level' && option.type === 'spin');
  const commands: string[] = [];
  const set = (name: string, value: number | boolean) => commands.push(`setoption name ${name} value ${value}`);
  if (settings.threads !== undefined) set('Threads', settings.threads);
  if (settings.hashMb !== undefined) set('Hash', settings.hashMb);
  if (settings.multiPv !== undefined) set('MultiPV', settings.multiPv);
  if (settings.strength.kind === 'full') {
    if (limitStrength) set('UCI_LimitStrength', false);
    if (skillLevel && (skillLevel.min ?? 0) <= 20 && (skillLevel.max ?? 20) >= 20) set('Skill Level', 20);
  } else if (settings.strength.kind === 'skill') {
    if (limitStrength) set('UCI_LimitStrength', false);
    set('Skill Level', settings.strength.value);
  } else {
    set('UCI_LimitStrength', true);
    set('UCI_Elo', settings.strength.value);
  }
  return commands;
}

class LineQueue {
  private items: string[] = [];
  private waiters: Array<{ resolve: (line: string) => void; reject: (reason: Error) => void }> = [];
  private failure?: Error;
  push(line: string): void {
    if (this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(line);
    else if (this.items.length < 1024) this.items.push(line);
    else this.fail(new Error('Engine output exceeded the buffer'));
  }
  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  next(timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    let resolve!: (value: string) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const waiter = {
      resolve: (line: string) => { cleanup(); resolve(line); },
      reject: (reason: Error) => { cleanup(); reject(reason); },
    };
    const expire = () => {
      this.waiters = this.waiters.filter(item => item !== waiter);
      reject(new Error('Engine timed out'));
      cleanup();
    };
    const onAbort = () => { clearTimeout(timer); timer = setTimeout(expire, Math.min(STOP_MS, timeoutMs)); };
    timer = setTimeout(expire, timeoutMs);
    this.waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return promise;
  }
}

class EventQueue implements AsyncIterable<EngineEvent> {
  private events: EngineEvent[] = [];
  private waiter?: (result: IteratorResult<EngineEvent>) => void;
  private ended = false;
  push(event: EngineEvent): boolean {
    if (this.ended) return false;
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve({ value: event, done: false }); }
    else if (this.events.length < 256) this.events.push(event);
    else return false;
    return true;
  }
  end(): void {
    this.ended = true;
    if (this.waiter && !this.events.length) { this.waiter({ value: undefined, done: true }); this.waiter = undefined; }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    while (this.events.length || !this.ended) {
      if (this.events.length) { yield this.events.shift()!; continue; }
      let resolve!: (result: IteratorResult<EngineEvent>) => void;
      const promise = new Promise<IteratorResult<EngineEvent>>(res => { resolve = res; });
      this.waiter = resolve;
      const result = await promise;
      if (result.done) break;
      yield result.value;
    }
  }
}

/** Owns UCI stdout, search serialization, stop/bestmove/readiness fences, and transport failure. */
export class UciSession {
  private lines = new LineQueue();
  private descriptor?: EngineDescriptor;
  private initializing?: Promise<EngineDescriptor>;
  /** Full advertised options for trusted administrator configuration only; never publish to clients. */
  advertisedOptions: readonly UciOption[] = [];
  private tail: Promise<void> = Promise.resolve();
  private active?: AbortController;
  private latest?: AbortController;
  private readyDone = false;
  private handshakeDeadline?: number;
  private disposed = false;
  private gameRoot?: string;
  private forceNewGame = true;
  constructor(private readonly transport: UciTransport, private readonly id: string, private readonly buildVersion = 'unknown', private readonly caps?: ResourceCaps) {
    void this.readOutput();
  }
  private async readOutput(): Promise<void> {
    let fragment = '';
    try {
      for await (const chunk of this.transport.output) {
        fragment += chunk.replace(/\r/g, '');
        let end: number;
        while ((end = fragment.indexOf('\n')) >= 0) {
          const line = fragment.slice(0, end);
          fragment = fragment.slice(end + 1);
          if (line.length > MAX_LINE) throw new Error('Engine output line too long');
          this.lines.push(line);
        }
        if (fragment.length > MAX_LINE) throw new Error('Engine output line too long');
      }
      this.lines.fail(new Error('Engine disconnected'));
    } catch { this.lines.fail(new Error('Engine disconnected')); }
  }
  async probe(): Promise<EngineDescriptor> {
    if (this.disposed) throw new Error('Engine disposed');
    if (this.descriptor) return this.descriptor;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      this.handshakeDeadline = Date.now() + HANDSHAKE_MS;
      await this.transport.write('uci');
      const deadline = this.handshakeDeadline;
      let name = '', author = '';
      const options: UciOption[] = [];
      while (true) {
        const line = await this.lines.next(Math.max(1, deadline - Date.now()));
        if (line === 'uciok') break;
        if (line.startsWith('id name ')) name = line.slice(8).slice(0, 256);
        if (line.startsWith('id author ')) author = line.slice(10).slice(0, 256);
        const parsed = parseUciOption(line);
        if (parsed) options.push(parsed);
      }
      this.advertisedOptions = options;
      return this.descriptor = { id: this.id, name: name || this.id, author, buildVersion: this.buildVersion, options: options.filter(option => safeOptionTypes[option.name.toLowerCase()] === option.type) };
    })();
    try { return await this.initializing; }
    catch (error) { await this.dispose(); throw error; }
    finally { this.initializing = undefined; }
  }
  async initialize(): Promise<EngineDescriptor> {
    const descriptor = await this.probe();
    if (!this.readyDone) {
      try {
        await this.ready(this.handshakeDeadline);
        this.readyDone = true;
      } catch (error) {
        await this.dispose();
        throw error;
      }
    }
    return descriptor;
  }
  /** Trusted administrator options, sent after probe() and before the first readiness fence. */
  async configure(commands: string[]): Promise<void> {
    await this.probe();
    if (this.readyDone) throw new Error('Engine startup options must precede readiness');
    try {
      for (const command of commands) {
        if (!/^setoption name [^\x00-\x1f\x7f]+(?: value [^\x00-\x1f\x7f]*)?$/.test(command)) throw new Error('Invalid administrator option command');
        await this.transport.write(command);
      }
      await this.ready(this.handshakeDeadline);
      this.readyDone = true;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }
  private async ready(deadline = Date.now() + HANDSHAKE_MS): Promise<void> {
    await this.transport.write('isready');
    while (await this.lines.next(Math.max(1, deadline - Date.now())) !== 'readyok') { /* ignore diagnostics */ }
  }
  /** Call at a document boundary if two distinct games share the same initial FEN. */
  newGame(): void { this.forceNewGame = true; }
  analyze(request: AnalysisRequest, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const events = new EventQueue();
    this.latest?.abort();
    const controller = new AbortController();
    this.latest = controller;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const task = this.tail.then(async () => {
      if (controller.signal.aborted) {
        events.push({ type: 'done', requestId: request.requestId, reason: 'cancelled' });
        signal.removeEventListener('abort', abort);
        events.end();
        return;
      }
      this.active = controller;
      try { await this.search(request, controller.signal, events); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        const code = message.includes('timed out') ? 'ENGINE_TIMEOUT' : message.includes('start failed') ? 'ENGINE_START_FAILED' : message.includes('buffer') ? 'SLOW_CONSUMER' : message.includes('disconnected') ? 'ENGINE_CRASHED' : 'INVALID_ENGINE_OUTPUT';
        events.push({ type: 'error', requestId: request.requestId, code, message: code === 'ENGINE_TIMEOUT' ? 'The engine did not respond in time. Retry the engine.' : code === 'ENGINE_START_FAILED' ? 'The engine could not start. Check the profile and retry.' : code === 'SLOW_CONSUMER' ? 'The engine output could not be consumed. Retry.' : code === 'ENGINE_CRASHED' ? 'The engine stopped unexpectedly. Retry.' : 'The engine returned invalid output or settings. Check the configuration.' });
        await this.dispose();
      } finally {
        if (this.active === controller) this.active = undefined;
        if (this.latest === controller) this.latest = undefined;
        signal.removeEventListener('abort', abort);
        events.end();
      }
    });
    this.tail = task.catch(() => {});
    return events;
  }
  private async search(request: AnalysisRequest, signal: AbortSignal, events: EventQueue): Promise<void> {
    const chess = validateAnalysisRequest(request, undefined, this.caps);
    if (chess.isGameOver()) {
      events.push({ type: 'bestmove', requestId: request.requestId, move: null });
      events.push({ type: 'done', requestId: request.requestId, reason: 'completed' });
      return;
    }
    let descriptor: EngineDescriptor;
    try { descriptor = await this.initialize(); }
    catch (error) {
      if (error instanceof Error && /timed out|disconnected/.test(error.message)) throw error;
      throw new Error('Engine start failed', { cause: error });
    }
    const legal = chess.moves({ verbose: true });
    const advertisedMultiPv = descriptor.options.some(option => option.name.toLowerCase() === 'multipv');
    const multiPv = Math.min(request.settings.multiPv ?? 1, legal.length);
    const settings = { ...request.settings, multiPv: advertisedMultiPv ? multiPv : undefined };
    validateAnalysisRequest({ ...request, settings }, descriptor, this.caps);
    if (signal.aborted) { events.push({ type: 'done', requestId: request.requestId, reason: 'cancelled' }); return; }
    for (const command of settingsCommands(settings, descriptor, this.caps)) await this.transport.write(command);
    if (this.forceNewGame || this.gameRoot !== request.position.initialFen) {
      await this.transport.write('ucinewgame');
      this.gameRoot = request.position.initialFen;
      this.forceNewGame = false;
    }
    await this.ready();
    if (signal.aborted) { events.push({ type: 'done', requestId: request.requestId, reason: 'cancelled' }); return; }
    await this.transport.write(positionCommand(request.position));
    await this.transport.write(goCommand(request));
    events.push({ type: 'started', requestId: request.requestId });
    let stopped = false;
    let stopDeadline = Infinity;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stopDeadline = Date.now() + STOP_MS;
      try {
        void Promise.resolve(this.transport.write('stop')).catch(() => this.lines.fail(new Error('Engine disconnected')));
      } catch { this.lines.fail(new Error('Engine disconnected')); }
    };
    signal.addEventListener('abort', stop, { once: true });
    const moves = new Set(legal.map(move => `${move.from}${move.to}${move.promotion ?? ''}`));
    try {
      while (true) {
        if (signal.aborted) stop();
        const line = await this.lines.next(stopped ? Math.max(1, stopDeadline - Date.now()) : request.limit.kind === 'bounded' ? 360000 : 86400000, signal);
        if (line.startsWith('bestmove ')) {
          const parts = line.trim().split(/\s+/);
          const move = parts[1] === '(none)' || parts[1] === '0000' ? null : parts[1];
          if (!stopped && (!move || !moves.has(move) || (request.searchMoves && !request.searchMoves.includes(move)))) throw new Error('Invalid engine bestmove');
          if (!stopped) {
            events.push({ type: 'bestmove', requestId: request.requestId, move, ...(parts[2] === 'ponder' && uciMovePattern.test(parts[3] ?? '') ? { ponder: parts[3] } : {}) });
            events.push({ type: 'done', requestId: request.requestId, reason: 'completed' });
          } else {
            await this.ready();
            events.push({ type: 'done', requestId: request.requestId, reason: 'cancelled' });
          }
          break;
        }
        if (!stopped) {
          const info = parseInfo(line, request.requestId);
          if (info && !events.push(info)) { stop(); throw new Error('Engine output exceeded the consumer buffer'); }
        }
      }
    } finally { signal.removeEventListener('abort', stop); }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.latest?.abort();
    this.active?.abort();
    this.lines.fail(new Error('Engine disconnected'));
    try { await this.transport.write('quit'); } catch { /* Always terminate the transport. */ }
    await this.transport.dispose();
  }
}
