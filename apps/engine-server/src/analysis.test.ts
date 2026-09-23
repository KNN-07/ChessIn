import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const binary = process.env.STOCKFISH_PATH ?? '/tmp/stockfish/stockfish-linux-x86-64-universal';
const token = 'a'.repeat(64);
const base = {
  requestId: 'test_1', engineId: 'stockfish',
  position: { initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [] },
  settings: { strength: { kind: 'full' } }, limit: { kind: 'bounded', depth: 1 },
};

it('rejects an absent or short server secret', async () => {
  await expect(loadConfig({ CHESSIN_API_TOKEN: 'short' })).rejects.toThrow('CHESSIN_API_TOKEN');
});

describe.runIf(existsSync(binary))('API admission and strict validation against a real UCI engine', () => {
  it('authenticates before parsing and rejects disallowed origins and unknown request fields', async () => {
    const app = await buildServer(await loadConfig({ CHESSIN_API_TOKEN: token, STOCKFISH_PATH: binary }));
    try {
      const unauthorized = await app.inject({ method: 'POST', url: '/v1/analyze', headers: { 'content-type': 'application/json' }, payload: '{not json' });
      expect(unauthorized.statusCode).toBe(401);
      const origin = await app.inject({ method: 'GET', url: '/v1/engines', headers: { authorization: `Bearer ${token}`, origin: 'https://elsewhere.invalid' } });
      expect(origin.statusCode).toBe(403);
      expect(origin.json().error.code).toBe('ORIGIN_FORBIDDEN');
      const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/analyze', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
      expect(preflight.statusCode).toBe(204);
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      for (const body of [{ ...base, extra: true }, { ...base, position: { ...base.position, moves: ['e2e5'] } }, { ...base, settings: { ...base.settings, hashMb: 1024 } }, { ...base, requestId: 'line\ninj' }]) {
        const response = await app.inject({ method: 'POST', url: '/v1/analyze', headers, payload: body });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('INVALID_REQUEST');
      }
      const unknown = await app.inject({ method: 'POST', url: '/v1/analyze', headers, payload: { ...base, engineId: 'unknown' } });
      expect(unknown.statusCode).toBe(404);
      const unsupportedType = await app.inject({ method: 'POST', url: '/v1/analyze', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, payload: 'no' });
      expect(unsupportedType.statusCode).toBe(415);
    } finally { await app.close(); }
  });
});
