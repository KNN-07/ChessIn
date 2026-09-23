import type { PositionSpec } from './game.js';
export type { PositionSpec } from './game.js';
export type SearchLimit =
  | { kind: 'bounded'; depth?: number; moveTimeMs?: number; nodes?: number }
  | { kind: 'infinite' }
  | { kind: 'clock'; whiteMs: number; blackMs: number; whiteIncrementMs: number; blackIncrementMs: number };
export type EngineSettings = {
  threads?: number;
  hashMb?: number;
  multiPv?: number;
  strength: { kind: 'full' } | { kind: 'skill'; value: number } | { kind: 'elo'; value: number };
};
export type AnalysisRequest = {
  requestId: string;
  engineId: string;
  position: PositionSpec;
  settings: EngineSettings;
  limit: SearchLimit;
  searchMoves?: string[];
};
export type EngineScore = { kind: 'cp' | 'mate'; value: number; bound?: 'lower' | 'upper' };
export type EngineEvent =
  | { type: 'started'; requestId: string }
  | { type: 'info'; requestId: string; depth: number; multiPv: number; score?: EngineScore; pv: string[]; nodes?: number; nps?: number; timeMs?: number; hashfull?: number }
  | { type: 'bestmove'; requestId: string; move: string | null; ponder?: string }
  | { type: 'done'; requestId: string; reason: 'completed' | 'cancelled' | 'limit' }
  | { type: 'error'; requestId: string; code: EngineFailureCode; message: string };
export type EngineFailureCode = 'ENGINE_START_FAILED' | 'ENGINE_TIMEOUT' | 'ENGINE_CRASHED' | 'INVALID_ENGINE_OUTPUT' | 'SLOW_CONSUMER' | 'REMOTE_DISCONNECTED';
export type UciOption = { name: string; type: 'spin' | 'check' | 'combo' | 'button' | 'string'; default?: string | number | boolean; min?: number; max?: number; vars?: string[] };
export type EngineDescriptor = { id: string; name: string; author: string; buildVersion: string; options: UciOption[] };
export interface EngineAdapter {
  initialize(): Promise<EngineDescriptor>;
  analyze(request: AnalysisRequest, signal: AbortSignal): AsyncIterable<EngineEvent>;
  dispose(): Promise<void>;
}
export type ResourceCaps = { maxThreads: number; maxHashMb: number; maxMultiPv: number };
