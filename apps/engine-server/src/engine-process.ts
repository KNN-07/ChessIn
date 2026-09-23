import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { EngineDescriptor, ResourceCaps, UciOption } from '@chessin/core/engine';
import { UciSession, type UciTransport } from '@chessin/core/uci';
import type { EngineConfig } from './config.js';

const control = /[\x00-\x1f\x7f]/;
export interface PreparedEngine { config: EngineConfig; descriptor: EngineDescriptor; startupCommands: string[] }

/** A single job owns a single child. dispose() does not return until close/reaping. */
export class NativeEngine implements UciTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  readonly spawned: Promise<void>;
  readonly output: AsyncIterable<string>;
  private closing?: Promise<void>;

  constructor(config: EngineConfig) {
    this.child = spawn(config.command, config.args, {
      cwd: config.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C', LC_ALL: 'C' },
    });
    const child = this.child;
    this.spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', error => reject(error));
    });
    this.closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    // Drain diagnostic output without retaining or exposing it.
    child.stderr.resume();
    child.stdin.on('error', () => { /* write() receives its own failure */ });
    child.stdout.setEncoding('utf8');
    this.output = child.stdout as AsyncIterable<string>;
  }

  async write(command: string): Promise<void> {
    if (!command || control.test(command)) throw new Error('Invalid engine command');
    await this.spawned;
    if (this.child.stdin.destroyed) throw new Error('Engine disconnected');
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${command}\n`, error => error ? reject(error) : resolve());
    });
  }

  dispose(): Promise<void> { return this.closing ??= this.reap(); }
  private async reap(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) { await this.closed; return; }
    try { this.child.stdin.write('quit\n'); } catch { /* broken pipe */ }
    if (await this.exitedWithin(1000)) return;
    this.child.kill('SIGTERM');
    if (await this.exitedWithin(1000)) return;
    this.child.kill('SIGKILL');
    await this.closed;
  }
  private async exitedWithin(ms: number): Promise<boolean> {
    return Promise.race([this.closed.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), ms))]);
  }
}

function optionCommand(option: UciOption, value: string | number | boolean): string {
  const text = String(value);
  if (control.test(text) || text.length > 4096) throw new Error(`Invalid configured ${option.name}`);
  if (option.type === 'button') {
    if (value !== true) throw new Error(`Invalid configured ${option.name}`);
    return `setoption name ${option.name}`;
  }
  if (option.type === 'spin') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(number) || number < (option.min ?? -Infinity) || number > (option.max ?? Infinity)) throw new Error(`Invalid configured ${option.name}`);
  } else if (option.type === 'check') {
    if (value !== true && value !== false && value !== 'true' && value !== 'false') throw new Error(`Invalid configured ${option.name}`);
  } else if (option.type === 'combo' && !option.vars?.includes(text)) throw new Error(`Invalid configured ${option.name}`);
  return `setoption name ${option.name} value ${text}`;
}

/** Admin options precede server-owned resource defaults. The client never supplies raw UCI. */
function startupOptions(config: EngineConfig, options: readonly UciOption[], caps: ResourceCaps): string[] {
  const commands: string[] = [];
  for (const [name, value] of Object.entries(config.options ?? {})) {
    const option = options.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (!option) throw new Error(`Engine ${config.id} does not advertise administrator option ${name}`);
    const resourceCap = name.toLowerCase() === 'threads' ? caps.maxThreads : name.toLowerCase() === 'hash' ? caps.maxHashMb : name.toLowerCase() === 'multipv' ? caps.maxMultiPv : undefined;
    if (resourceCap !== undefined && (option.type !== 'spin' || Number(value) > resourceCap)) throw new Error(`Engine ${config.id} administrator resource option exceeds ceiling`);
    commands.push(optionCommand(option, value));
  }
  for (const [name, fallback, ceiling] of [['Threads', 1, caps.maxThreads], ['Hash', 64, caps.maxHashMb], ['MultiPV', 1, caps.maxMultiPv]] as const) {
    const option = options.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (!option) continue;
    if (option.type !== 'spin' || (option.min ?? 1) > ceiling) throw new Error(`Engine ${config.id} minimum ${name} exceeds server ceiling`);
    const floor = name === 'Hash' ? 16 : 1;
    if ((option.max ?? ceiling) < floor) throw new Error(`Engine ${config.id} maximum ${name} is unusable`);
    commands.push(optionCommand(option, Math.max(option.min ?? floor, Math.min(fallback, option.max ?? ceiling, ceiling))));
  }
  return commands;
}

export async function probeEngine(config: EngineConfig, caps: ResourceCaps): Promise<PreparedEngine> {
  const transport = new NativeEngine(config);
  const session = new UciSession(transport, config.id, 'unknown', caps);
  try {
    await transport.spawned;
    const descriptor = await session.probe();
    const startupCommands = startupOptions(config, session.advertisedOptions, caps);
    await session.configure(startupCommands);
    const version = descriptor.name.match(/(?:^|\s)(\d+(?:\.\d+){0,2})(?:\s|$)/)?.[1] ?? 'unknown';
    return { config, descriptor: { ...descriptor, buildVersion: version }, startupCommands };
  } catch (error) {
    const detail = error instanceof Error && (/^Engine [A-Za-z0-9_-]+ /.test(error.message) || /^Invalid configured /.test(error.message)) ? error.message : 'binary failed UCI startup';
    throw new Error(`Engine configuration error (${config.id}): ${detail}`);
  }
  finally { await session.dispose(); }
}

export async function openEngine(prepared: PreparedEngine, caps: ResourceCaps, signal?: AbortSignal): Promise<UciSession> {
  const transport = new NativeEngine(prepared.config);
  const session = new UciSession(transport, prepared.config.id, prepared.descriptor.buildVersion, caps);
  const interrupt = () => { void session.dispose(); };
  signal?.addEventListener('abort', interrupt, { once: true });
  try {
    await transport.spawned;
    if (signal?.aborted) throw new Error('Engine startup interrupted');
    await session.probe();
    await session.configure(prepared.startupCommands);
    if (signal?.aborted) throw new Error('Engine startup interrupted');
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  } finally {
    signal?.removeEventListener('abort', interrupt);
  }
}
