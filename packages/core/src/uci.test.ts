import { describe, expect, it } from 'vitest';
import type { AnalysisRequest, EngineDescriptor, EngineEvent } from './engine.js';
import { validateAnalysisRequest } from './protocol.js';
import { UciSession, goCommand, parseInfo, parseUciOption, positionCommand, settingsCommands, type UciTransport } from './uci.js';

const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const descriptor: EngineDescriptor = { id: 'stockfish', name: 'Stockfish', author: 'Stockfish authors', buildVersion: '19', options: [
  { name: 'Threads', type: 'spin', min: 1, max: 8 },
  { name: 'Hash', type: 'spin', min: 1, max: 1024 },
  { name: 'MultiPV', type: 'spin', min: 1, max: 100 },
  { name: 'Skill Level', type: 'spin', min: 0, max: 20 },
  { name: 'UCI_LimitStrength', type: 'check' },
  { name: 'UCI_Elo', type: 'spin', min: 1320, max: 3190 },
] };
const request = (requestId: string): AnalysisRequest => ({ requestId, engineId: 'stockfish', position: { initialFen: startFen, moves: [] }, settings: { strength: { kind: 'full' }, multiPv: 3 }, limit: { kind: 'bounded', depth: 12, moveTimeMs: 1000 } });

class FakeTransport implements UciTransport {
  commands: string[] = [];
  private chunks: string[] = [];
  private pending?: (value: IteratorResult<string>) => void;
  private closed = false;
  output: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: () => {
    if (this.chunks.length) return Promise.resolve({ value: this.chunks.shift()!, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    let resolve!: (result: IteratorResult<string>) => void;
    const promise = new Promise<IteratorResult<string>>(res => { resolve = res; });
    this.pending = resolve;
    return promise;
  } }) };
  feed(chunk: string) {
    if (this.pending) { const resolve = this.pending; this.pending = undefined; resolve({ value: chunk, done: false }); }
    else this.chunks.push(chunk);
  }
  write(command: string) {
    this.commands.push(command);
    if (command === 'uci') this.feed('id name Stockfish 19\nid author Authors\noption name MultiPV type spin default 1 min 1 max 5\noption name WeightsFile type string default <empty>\nuciok\n');
    if (command === 'isready') this.feed('readyok\n');
    if (command === 'stop') this.feed('bestmove e2e4\n');
  }
  dispose() { this.closed = true; this.pending?.({ value: undefined, done: true }); }
}

async function untilStarted(stream: AsyncIterable<EngineEvent>) {
  const iterator = stream[Symbol.asyncIterator]();
  const result = await iterator.next();
  expect(result.value?.type).toBe('started');
  return iterator;
}

describe('UCI boundaries', () => {
  it('parses mate scores, bounds, optional fields and advertised options without confusing centipawns', () => {
    expect(parseInfo('info depth 14 multipv 2 score mate -3 upperbound nodes 1000 nps 200 time 5 pv e2e4 e7e5', 'a')).toEqual({
      type: 'info', requestId: 'a', depth: 14, multiPv: 2, score: { kind: 'mate', value: -3, bound: 'upper' }, nodes: 1000, nps: 200, timeMs: 5, pv: ['e2e4', 'e7e5'],
    });
    expect(parseUciOption('option name UCI_Elo type spin default 1320 min 1320 max 3190')).toEqual({ name: 'UCI_Elo', type: 'spin', default: 1320, min: 1320, max: 3190 });
  });

  it('only emits safe advertised controls and resets weakened engines for full-strength review', () => {
    expect(settingsCommands({ strength: { kind: 'full' }, threads: 2, hashMb: 64 }, descriptor)).toEqual([
      'setoption name Threads value 2', 'setoption name Hash value 64', 'setoption name UCI_LimitStrength value false', 'setoption name Skill Level value 20',
    ]);
    expect(() => settingsCommands({ strength: { kind: 'elo', value: 1000 } }, descriptor)).toThrow();
    expect(settingsCommands({ strength: { kind: 'full' } }, { ...descriptor, options: [] })).toEqual([]);
  });

  it('validates complete chess history and searchmove legality before admission', () => {
    expect(() => validateAnalysisRequest({ ...request('a'), position: { initialFen: startFen, moves: ['e2e5'] } })).toThrow();
    expect(() => validateAnalysisRequest({ ...request('a'), surprise: true })).toThrow();
    expect(() => validateAnalysisRequest({ ...request('a'), searchMoves: ['e2e5'] })).toThrow();
    expect(() => validateAnalysisRequest({ ...request('a'), searchMoves: ['e2e4', 'e2e4'] })).toThrow();
    expect(() => validateAnalysisRequest({ ...request('a'), limit: { kind: 'bounded' } })).toThrow();
    expect(positionCommand({ initialFen: startFen, moves: ['e2e4', 'e7e5'] })).toContain('moves e2e4 e7e5');
    expect(goCommand(request('a'))).toBe('go depth 12 movetime 1000');
    expect(() => goCommand({ ...request('a'), searchMoves: ['e2e4\nquit'] })).toThrow();
    expect(() => positionCommand({ initialFen: `${startFen}\nquit`, moves: [] })).toThrow();
  });

  it('keeps administrator-only options private and fences startup configuration once', async () => {
    const transport = new FakeTransport();
    const session = new UciSession(transport, 'stockfish');
    const probed = await session.probe();
    expect(probed.options.map(option => option.name)).toEqual(['MultiPV']);
    expect(session.advertisedOptions.map(option => option.name)).toEqual(['MultiPV', 'WeightsFile']);
    expect(transport.commands).toEqual(['uci']);
    await session.configure(['setoption name WeightsFile value /operator/model.nnue']);
    expect(await session.initialize()).toBe(probed);
    expect(transport.commands).toEqual(['uci', 'setoption name WeightsFile value /operator/model.nnue', 'isready']);
    await session.dispose();
    expect(transport.commands.at(-1)).toBe('quit');
  });

  it('consumes the old bestmove and ready fence before searching a superseding request', async () => {
    const transport = new FakeTransport();
    const session = new UciSession(transport, 'stockfish', '19');
    const a = await untilStarted(session.analyze(request('a'), new AbortController().signal));
    transport.feed('info dep');
    transport.feed('th 10 score mate 3 pv e2e4\n');
    expect((await a.next()).value).toMatchObject({ requestId: 'a', type: 'info', score: { kind: 'mate', value: 3 } });
    const b = session.analyze(request('b'), new AbortController().signal);
    const eventsA = (await a.next()).value;
    expect(eventsA).toMatchObject({ type: 'done', reason: 'cancelled' });
    const iteratorB = await untilStarted(b);
    const stop = transport.commands.indexOf('stop');
    const ready = transport.commands.indexOf('isready', stop);
    const gos = transport.commands.flatMap((command, index) => command.startsWith('go ') ? [index] : []);
    expect(stop).toBeGreaterThan(gos[0]);
    expect(ready).toBeGreaterThan(stop);
    expect(gos[1]).toBeGreaterThan(ready);
    transport.feed('bestmove d2d4\n');
    expect((await iteratorB.next()).value).toMatchObject({ type: 'bestmove', requestId: 'b', move: 'd2d4' });
    await session.dispose();
  });

  it('returns terminal null without initializing a transport', async () => {
    const transport = new FakeTransport();
    const session = new UciSession(transport, 'stockfish');
    const terminal = { ...request('mate'), position: { initialFen: startFen, moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'] } };
    const events = [];
    for await (const event of session.analyze(terminal, new AbortController().signal)) events.push(event);
    expect(events).toEqual([{ type: 'bestmove', requestId: 'mate', move: null }, { type: 'done', requestId: 'mate', reason: 'completed' }]);
    expect(transport.commands).toEqual([]);
    await session.dispose();
  });
});
