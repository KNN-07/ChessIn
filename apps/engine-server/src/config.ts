import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface EngineConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  options?: Record<string, string | number | boolean>;
}
export interface ServerConfig {
  host: string;
  port: number;
  tokenHash: Buffer;
  allowedOrigins: Set<string>;
  engines: EngineConfig[];
  maxConcurrent: number;
  maxJobMs: number;
  maxThreads: number;
  maxHashMb: number;
  maxMultiPv: 5;
}

const identifier = /^[A-Za-z0-9_-]{1,64}$/;
const control = /[\x00-\x1f\x7f]/;
const defaultOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];
function positive(value: string | undefined, fallback: number, label: string, cap: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > cap) throw new Error(`Invalid ${label}`);
  return n;
}
function keys(obj: Record<string, unknown>, permitted: string[], label: string): void {
  if (Object.keys(obj).some(key => !permitted.includes(key))) throw new Error(`Unknown ${label} field`);
}
function plain(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || control.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function origin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value) throw new Error('Invalid allowed origin');
  return value;
}
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const token = env.CHESSIN_API_TOKEN;
  if (!token || token.length < 32 || control.test(token)) throw new Error('CHESSIN_API_TOKEN must be at least 32 characters without control characters');
  let engines: EngineConfig[] = [{ id: 'stockfish', name: 'Stockfish', command: env.STOCKFISH_PATH ?? '/opt/stockfish/stockfish-linux-x86-64-universal', args: [] }];
  if (env.CHESSIN_ENGINE_CONFIG) {
    const parsed: unknown = JSON.parse(await readFile(env.CHESSIN_ENGINE_CONFIG, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid engine configuration');
    const rawConfig = parsed as Record<string, unknown>;
    keys(rawConfig, ['engines'], 'engine configuration');
    const entries = rawConfig.engines;
    if (!Array.isArray(entries) || !entries.length) throw new Error('Engine catalog must not be empty');
    engines = entries.map((entry: unknown): EngineConfig => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid engine entry');
      const e = entry as Record<string, unknown>;
      keys(e, ['id', 'name', 'command', 'args', 'cwd', 'options'], 'engine');
      if (typeof e.id !== 'string' || !identifier.test(e.id)) throw new Error('Invalid engine ID');
      const name = plain(e.name, 'engine name');
      const command = plain(e.command, 'engine executable', 4096);
      if (!isAbsolute(command)) throw new Error('Engine executable must be an absolute path');
      if (!Array.isArray(e.args) || e.args.length > 32 || !e.args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !control.test(arg))) throw new Error('Invalid engine arguments');
      const cwd = e.cwd === undefined ? undefined : plain(e.cwd, 'engine working directory', 4096);
      if (cwd !== undefined && !isAbsolute(cwd)) throw new Error('Engine working directory must be absolute');
      const options = e.options;
      if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw new Error('Invalid admin engine options');
      if (options) for (const [key, value] of Object.entries(options)) {
        if (!key || key.length > 128 || control.test(key) || typeof value === 'object' || typeof value === 'undefined' || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && (value.length > 4096 || control.test(value)))) throw new Error('Invalid admin engine option');
      }
      return { id: e.id, name, command, args: e.args as string[], ...(cwd ? { cwd } : {}), ...(options ? { options: options as EngineConfig['options'] } : {}) };
    });
  }
  if (new Set(engines.map(engine => engine.id)).size !== engines.length) throw new Error('Duplicate engine ID');
  for (const engine of engines) if (!isAbsolute(engine.command)) throw new Error('Engine executable must be an absolute path');
  const origins = env.CHESSIN_ALLOWED_ORIGINS?.split(',').map(item => item.trim()) ?? defaultOrigins;
  if (!origins.length || origins.some(item => !item)) throw new Error('Invalid allowed origins');
  const host = plain(env.CHESSIN_HOST ?? '127.0.0.1', 'host');
  return {
    host, port: positive(env.CHESSIN_PORT, 8787, 'port', 65535),
    tokenHash: createHash('sha256').update(token).digest(), allowedOrigins: new Set(origins.map(origin)), engines,
    maxConcurrent: positive(env.CHESSIN_MAX_CONCURRENT, 2, 'max concurrent jobs', 128),
    maxJobMs: positive(env.CHESSIN_MAX_JOB_MS, 300000, 'max job duration', 86400000),
    maxThreads: positive(env.CHESSIN_MAX_THREADS, 4, 'max threads', 8),
    maxHashMb: positive(env.CHESSIN_MAX_HASH_MB, 256, 'max hash', 256), maxMultiPv: 5,
  };
}
export function authorized(header: string | undefined, expected: Buffer): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = createHash('sha256').update(header.slice(7)).digest();
  return timingSafeEqual(supplied, expected);
}
