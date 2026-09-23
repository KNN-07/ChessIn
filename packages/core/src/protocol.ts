import { validatePosition } from './game.js';
import type { Chess } from 'chess.js';
import type { AnalysisRequest, EngineDescriptor, EngineSettings, ResourceCaps, UciOption } from './engine.js';

export const protocolVersion = 1;
export const uciMovePattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const defaults: ResourceCaps = { maxThreads: 8, maxHashMb: 256, maxMultiPv: 5 };
const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum } as const);
const move = { type: 'string', pattern: '^[a-h][1-8][a-h][1-8][qrbn]?$' } as const;
const bounded = { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'bounded' }, depth: integer(1, 60), moveTimeMs: integer(100, 300000), nodes: integer(1000, 1000000000) }, anyOf: [{ required: ['depth'] }, { required: ['moveTimeMs'] }, { required: ['nodes'] }] } as const;
export const analysisRequestSchema = {
  type: 'object', additionalProperties: false,
  required: ['requestId', 'engineId', 'position', 'settings', 'limit'],
  properties: {
    requestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    engineId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    position: { type: 'object', additionalProperties: false, required: ['initialFen', 'moves'], properties: {
      initialFen: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\x00-\\x1f\\x7f]+$' },
      moves: { type: 'array', maxItems: 2048, items: move },
    } },
    settings: { type: 'object', additionalProperties: false, required: ['strength'], properties: {
      threads: integer(1, 8), hashMb: integer(16, 256), multiPv: integer(1, 5),
      strength: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'full' } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: { kind: { const: 'skill' }, value: integer(0, 20) } },
        { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: { kind: { const: 'elo' }, value: integer(1, 4000) } },
      ] },
    } },
    limit: { oneOf: [bounded,
      { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'infinite' } } },
      { type: 'object', additionalProperties: false, required: ['kind', 'whiteMs', 'blackMs', 'whiteIncrementMs', 'blackIncrementMs'], properties: { kind: { const: 'clock' }, whiteMs: integer(0, 86400000), blackMs: integer(0, 86400000), whiteIncrementMs: integer(0, 60000), blackIncrementMs: integer(0, 60000) } },
    ] },
    searchMoves: { type: 'array', minItems: 1, maxItems: 218, uniqueItems: true, items: move },
  },
} as const;

const eventBase = { type: 'object', additionalProperties: false } as const;
const requestIdSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } as const;
export const engineEventSchema = { oneOf: [
  { ...eventBase, required: ['type', 'requestId'], properties: { type: { const: 'started' }, requestId: requestIdSchema } },
  { ...eventBase, required: ['type', 'requestId', 'depth', 'multiPv', 'pv'], properties: {
    type: { const: 'info' }, requestId: requestIdSchema, depth: integer(1, 1000), multiPv: integer(1, 218),
    score: { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: {
      kind: { enum: ['cp', 'mate'] }, value: integer(-1000000, 1000000), bound: { enum: ['lower', 'upper'] },
    } }, pv: { type: 'array', maxItems: 2048, items: move },
    nodes: integer(0, Number.MAX_SAFE_INTEGER), nps: integer(0, Number.MAX_SAFE_INTEGER),
    timeMs: integer(0, Number.MAX_SAFE_INTEGER), hashfull: integer(0, 1000),
  } },
  { ...eventBase, required: ['type', 'requestId', 'move'], properties: {
    type: { const: 'bestmove' }, requestId: requestIdSchema, move: { anyOf: [move, { type: 'null' }] }, ponder: move,
  } },
  { ...eventBase, required: ['type', 'requestId', 'reason'], properties: {
    type: { const: 'done' }, requestId: requestIdSchema, reason: { enum: ['completed', 'cancelled', 'limit'] },
  } },
  { ...eventBase, required: ['type', 'requestId', 'code', 'message'], properties: {
    type: { const: 'error' }, requestId: requestIdSchema,
    code: { enum: ['ENGINE_START_FAILED', 'ENGINE_TIMEOUT', 'ENGINE_CRASHED', 'INVALID_ENGINE_OUTPUT', 'SLOW_CONSUMER', 'REMOTE_DISCONNECTED'] },
    message: { type: 'string', maxLength: 512 },
  } },
] } as const;
export const engineDescriptorSchema = { type: 'object', additionalProperties: false, required: ['id', 'name', 'author', 'buildVersion', 'options'], properties: {
  id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  name: { type: 'string', maxLength: 256 }, author: { type: 'string', maxLength: 256 }, buildVersion: { type: 'string', maxLength: 128 },
  options: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: {
    name: { type: 'string', maxLength: 128 }, type: { enum: ['spin', 'check', 'combo', 'button', 'string'] },
    default: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
    min: { type: 'integer' }, max: { type: 'integer' }, vars: { type: 'array', items: { type: 'string' } },
  } } },
} } as const;

function object(value: unknown, keys: string[], required: string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) throw new Error(`${label} has an unknown field`);
  for (const key of required) if (!Object.hasOwn(result, key)) throw new Error(`${label} is missing ${key}`);
  return result;
}
function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
function identifier(value: unknown, label: string): void {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error(`Invalid ${label}`);
}
function legalMove(value: unknown): value is string { return typeof value === 'string' && uciMovePattern.test(value); }
function option(descriptor: EngineDescriptor | undefined, name: string): UciOption | undefined {
  return descriptor?.options.find(value => value.name.toLowerCase() === name.toLowerCase());
}
function checkOption(descriptor: EngineDescriptor, name: string, value: number, min: number, max: number): void {
  const advertised = option(descriptor, name);
  if (advertised?.type !== 'spin' || value < Math.max(min, advertised.min ?? min) || value > Math.min(max, advertised.max ?? max)) throw new Error(`Unsupported ${name} setting`);
}

/** Rejects unknown fields, invalid chess history and unsafe/unsupported controls before engine admission. */
export function validateAnalysisRequest(request: unknown, descriptor?: EngineDescriptor, caps: ResourceCaps = defaults): Chess {
  const input = object(request, ['requestId', 'engineId', 'position', 'settings', 'limit', 'searchMoves'], ['requestId', 'engineId', 'position', 'settings', 'limit'], 'request');
  identifier(input.requestId, 'requestId'); identifier(input.engineId, 'engineId');
  if (descriptor && input.engineId !== descriptor.id) throw new Error('Engine ID does not match the selected engine');
  const position = object(input.position, ['initialFen', 'moves'], ['initialFen', 'moves'], 'position');
  if (typeof position.initialFen !== 'string' || position.initialFen.length < 1 || position.initialFen.length > 256 || /[\x00-\x1f\x7f]/.test(position.initialFen)) throw new Error('Invalid initial FEN');
  if (!Array.isArray(position.moves) || position.moves.length > 2048 || !position.moves.every(legalMove)) throw new Error('Invalid move history');
  const settings = object(input.settings, ['threads', 'hashMb', 'multiPv', 'strength'], ['strength'], 'settings');
  const strength = object(settings.strength, ['kind', 'value'], ['kind'], 'strength');
  if (strength.kind === 'full') { if (Object.hasOwn(strength, 'value')) throw new Error('Full strength cannot specify a value'); }
  else if (strength.kind === 'skill') number(strength.value, 0, 20, 'skill');
  else if (strength.kind === 'elo') number(strength.value, 1, 4000, 'Elo');
  else throw new Error('Invalid strength');
  if (settings.threads !== undefined) number(settings.threads, 1, Math.min(8, caps.maxThreads), 'Threads');
  if (settings.hashMb !== undefined) number(settings.hashMb, 16, Math.min(256, caps.maxHashMb), 'Hash');
  if (settings.multiPv !== undefined) number(settings.multiPv, 1, Math.min(5, caps.maxMultiPv), 'MultiPV');
  const limit = object(input.limit, ['kind', 'depth', 'moveTimeMs', 'nodes', 'whiteMs', 'blackMs', 'whiteIncrementMs', 'blackIncrementMs'], ['kind'], 'limit');
  if (limit.kind === 'bounded') {
    for (const key of ['whiteMs', 'blackMs', 'whiteIncrementMs', 'blackIncrementMs']) if (Object.hasOwn(limit, key)) throw new Error('Invalid bounded limit');
    if (limit.depth === undefined && limit.moveTimeMs === undefined && limit.nodes === undefined) throw new Error('A bounded search requires a positive bound');
    if (limit.depth !== undefined) number(limit.depth, 1, 60, 'depth');
    if (limit.moveTimeMs !== undefined) number(limit.moveTimeMs, 100, 300000, 'time');
    if (limit.nodes !== undefined) number(limit.nodes, 1000, 1000000000, 'nodes');
  } else if (limit.kind === 'clock') {
    for (const key of ['depth', 'moveTimeMs', 'nodes']) if (Object.hasOwn(limit, key)) throw new Error('Invalid clock limit');
    for (const key of ['whiteMs', 'blackMs']) number(limit[key], 0, 86400000, key);
    for (const key of ['whiteIncrementMs', 'blackIncrementMs']) number(limit[key], 0, 60000, key);
  } else if (limit.kind === 'infinite') {
    if (Object.keys(limit).length !== 1) throw new Error('Invalid infinite limit');
  } else throw new Error('Invalid search limit');
  const chess = validatePosition({ initialFen: position.initialFen, moves: position.moves });
  if (input.searchMoves !== undefined) {
    if (!Array.isArray(input.searchMoves) || input.searchMoves.length < 1 || input.searchMoves.length > 218 || !input.searchMoves.every(legalMove) || new Set(input.searchMoves).size !== input.searchMoves.length) throw new Error('Invalid search moves');
    const legal = new Set(chess.moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`));
    if (input.searchMoves.some(m => !legal.has(m))) throw new Error('Illegal restricted search move');
  }
  if (descriptor) {
    if (settings.threads !== undefined) checkOption(descriptor, 'Threads', settings.threads as number, 1, caps.maxThreads);
    if (settings.hashMb !== undefined) checkOption(descriptor, 'Hash', settings.hashMb as number, 16, caps.maxHashMb);
    if (settings.multiPv !== undefined) checkOption(descriptor, 'MultiPV', settings.multiPv as number, 1, caps.maxMultiPv);
    if (strength.kind === 'skill') checkOption(descriptor, 'Skill Level', strength.value as number, 0, 20);
    if (strength.kind === 'elo') {
      if (option(descriptor, 'UCI_LimitStrength')?.type !== 'check') throw new Error('Unsupported Elo setting');
      checkOption(descriptor, 'UCI_Elo', strength.value as number, 1, 4000);
    }
  }
  return chess;
}

export function supportedSettings(settings: EngineSettings, descriptor: EngineDescriptor, caps?: ResourceCaps): void {
  const limits = caps ?? defaults;
  if (settings.threads !== undefined) { number(settings.threads, 1, Math.min(8, limits.maxThreads), 'Threads'); checkOption(descriptor, 'Threads', settings.threads, 1, limits.maxThreads); }
  if (settings.hashMb !== undefined) { number(settings.hashMb, 16, Math.min(256, limits.maxHashMb), 'Hash'); checkOption(descriptor, 'Hash', settings.hashMb, 16, limits.maxHashMb); }
  if (settings.multiPv !== undefined) { number(settings.multiPv, 1, Math.min(5, limits.maxMultiPv), 'MultiPV'); checkOption(descriptor, 'MultiPV', settings.multiPv, 1, limits.maxMultiPv); }
  if (settings.strength.kind === 'skill') { number(settings.strength.value, 0, 20, 'skill'); checkOption(descriptor, 'Skill Level', settings.strength.value, 0, 20); }
  if (settings.strength.kind === 'elo') {
    if (option(descriptor, 'UCI_LimitStrength')?.type !== 'check') throw new Error('Unsupported Elo setting');
    number(settings.strength.value, 1, 4000, 'Elo'); checkOption(descriptor, 'UCI_Elo', settings.strength.value, 1, 4000);
  }
}
