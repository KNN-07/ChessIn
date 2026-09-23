import { DEFAULT_POSITION, type Color } from 'chess.js'
import { appendMove, createGame, reconstruct, type GameDocument } from '@chessin/core/game'
import type { EngineSettings } from '@chessin/core/engine'
import { hasInsufficientMaterial } from '@chessin/core/material'

export interface PlayClock { monotonic(): number; wall(): number }
export const systemPlayClock: PlayClock = { monotonic: () => performance.now(), wall: () => Date.now() }
export type Side = 'w' | 'b'
export type PlayStatus = 'active' | 'suspended' | 'interrupted' | 'finished'
export type PlayReason = 'checkmate' | 'stalemate' | 'insufficient material' | 'threefold repetition' |
  '50-move rule' | 'resignation' | 'timeout' | 'timeout — insufficient material' | 'abandoned'
export interface PlayState {
  version: 1
  status: PlayStatus
  turn: Side
  humanColor: Side
  provider: 'local' | 'remote'
  profile: string
  engineId: string
  engineName: string
  engineVersion: string
  settings: EngineSettings
  initialMs: number | null
  incrementMs: number
  remaining: { w: number; b: number }
  /** Wall-clock deadline survives reload. Null for untimed/suspended/finished games. */
  deadlineWallMs: number | null
  result: '1-0' | '0-1' | '1/2-1/2' | null
  reason: PlayReason | null
}
export interface PlayOptions {
  humanColor: Side
  provider: 'local' | 'remote'
  profile: string
  engineId: string
  engineName: string
  engineVersion: string
  settings: EngineSettings
  initialMs: number | null
  incrementMs: number
}

export function readPlayState(game: GameDocument): PlayState | null {
  const value = game.play
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
      !('status' in value) || !['active', 'suspended', 'interrupted', 'finished'].includes(String(value.status)) ||
      !('remaining' in value) || !('humanColor' in value) || !('engineId' in value) ||
      !('turn' in value) || (value.turn !== 'w' && value.turn !== 'b')) return null
  return value as PlayState
}

function committed(game: GameDocument, state: PlayState, result = state.result): GameDocument {
  return {
    ...game, play: state, revision: game.revision + 1, updatedAt: new Date().toISOString(),
    headers: result ? { ...game.headers, Result: result } : game.headers,
  }
}
function opposite(color: Side): Side { return color === 'w' ? 'b' : 'w' }

/** The only owner of a play game's clocks and transitions; monotonic time within a tab,
 * persisted wall deadline only when recovering a previously active game. */
export class PlaySession {
  private document: GameDocument
  private deadlineMono: number | null
  private constructor(game: GameDocument, private readonly clock: PlayClock, deadlineMono: number | null) {
    this.document = game
    this.deadlineMono = deadlineMono
  }

  static begin(options: PlayOptions, clock: PlayClock = systemPlayClock): PlaySession {
    if (options.initialMs !== null && (!Number.isFinite(options.initialMs) || options.initialMs < 60_000 || options.initialMs > 10_800_000)) throw new Error('Choose 1–180 minutes')
    if (!Number.isFinite(options.incrementMs) || options.incrementMs < 0 || options.incrementMs > 60_000 || (options.initialMs === null && options.incrementMs !== 0)) throw new Error('Choose 0–60 seconds increment')
    const game: GameDocument = {
      ...createGame(DEFAULT_POSITION, `Game vs ${options.engineName}`),
      headers: { Event: 'Casual engine game', White: options.humanColor === 'w' ? 'You' : options.engineName,
        Black: options.humanColor === 'b' ? 'You' : options.engineName, Result: '*' },
    }
    const now = clock.monotonic()
    const state: PlayState = {
      version: 1, status: 'active', turn: 'w', humanColor: options.humanColor, provider: options.provider,
      profile: options.profile, engineId: options.engineId, engineName: options.engineName,
      engineVersion: options.engineVersion, settings: options.settings, initialMs: options.initialMs,
      incrementMs: options.incrementMs,
      remaining: { w: options.initialMs ?? 0, b: options.initialMs ?? 0 },
      deadlineWallMs: options.initialMs === null ? null : clock.wall() + options.initialMs,
      result: null, reason: null,
    }
    return new PlaySession(committed(game, state), clock, options.initialMs === null ? null : now + options.initialMs)
  }

  static restore(game: GameDocument, clock: PlayClock = systemPlayClock): PlaySession {
    const state = readPlayState(game)
    if (!state) throw new Error('This game has no saved play session')
    const session = new PlaySession(game, clock, null)
    if (state.status === 'active') {
      const turn = reconstruct(game).turn()
      if (state.initialMs !== null) {
        const left = Math.max(0, (state.deadlineWallMs ?? clock.wall()) - clock.wall())
        session.document = committed(game, { ...state, remaining: { ...state.remaining, [turn]: left }, deadlineWallMs: null, status: 'suspended' })
        if (left === 0) session.flag(turn)
      } else session.document = committed(game, { ...state, status: 'suspended', deadlineWallMs: null })
    }
    return session
  }

  get game(): GameDocument { return this.document }
  get state(): PlayState { return readPlayState(this.document)! }
  get turn(): Side { return reconstruct(this.document).turn() }
  get isActive(): boolean { return this.state.status === 'active' }

  remaining(color: Side): number | null {
    const state = this.state
    if (state.initialMs === null) return null
    return state.status === 'active' && color === this.turn && this.deadlineMono !== null
      ? Math.max(0, Math.min(this.deadlineMono - this.clock.monotonic(),
        (state.deadlineWallMs ?? Infinity) - this.clock.wall())) : state.remaining[color]
  }

  /** Returns true only when a live deadline actually flags; callers persist the new document. */
  tick(): boolean {
    if (!this.isActive || this.deadlineMono === null || this.remaining(this.turn)! > 0) return false
    this.flag(this.turn)
    return true
  }

  private finish(result: PlayState['result'], reason: PlayReason): void {
    const state = this.state
    const remaining = { ...state.remaining }
    if (state.status === 'active' && state.initialMs !== null)
      remaining[this.turn] = this.remaining(this.turn)!
    this.deadlineMono = null
    this.document = committed(this.document, { ...state, remaining, status: 'finished', result, reason, deadlineWallMs: null })
  }

  private flag(flagged: Side): void {
    const opponent = opposite(flagged)
    const draw = hasInsufficientMaterial(reconstruct(this.document), opponent)
    this.finish(draw ? '1/2-1/2' : opponent === 'w' ? '1-0' : '0-1',
      draw ? 'timeout — insufficient material' : 'timeout')
  }

  /** Reject a stale or late bestmove before touching the board or awarding an increment. */
  move(uci: string, actor: Side, expectedRevision = this.document.revision): GameDocument {
    if (!this.isActive || expectedRevision !== this.document.revision || actor !== this.turn) throw new Error('Stale or out-of-turn move')
    if (this.tick()) throw new Error('Move arrived after the flag fell')
    const before = this.document
    const next = appendMove(before, uci)
    if (next === before) throw new Error('Move was not accepted')
    const state = this.state
    const remaining = { ...state.remaining }
    if (state.initialMs !== null) {
      const left = this.remaining(actor)!
      if (left === 0) { this.flag(actor); throw new Error('Move arrived after the flag fell') }
      remaining[actor] = left + state.incrementMs
    }
    this.document = next
    const chess = reconstruct(next)
    const result = chess.isCheckmate() ? (actor === 'w' ? '1-0' : '0-1') :
      chess.isStalemate() || chess.isInsufficientMaterial() || chess.isThreefoldRepetition() || chess.isDrawByFiftyMoves() ? '1/2-1/2' : null
    if (result) {
      this.document = committed(next, { ...state, turn: chess.turn(), remaining, status: 'finished', deadlineWallMs: null, result,
        reason: chess.isCheckmate() ? 'checkmate' : chess.isStalemate() ? 'stalemate' :
          chess.isInsufficientMaterial() ? 'insufficient material' : chess.isThreefoldRepetition() ? 'threefold repetition' : '50-move rule' })
      this.deadlineMono = null
    } else {
      const other = opposite(actor)
      this.deadlineMono = state.initialMs === null ? null : this.clock.monotonic() + remaining[other]
      this.document = committed(next, { ...state, turn: chess.turn(), remaining,
        deadlineWallMs: state.initialMs === null ? null : this.clock.wall() + remaining[other] })
    }
    return this.document
  }

  suspend(interrupted = false): GameDocument {
    if (!this.isActive) return this.document
    if (this.tick()) return this.document
    const state = this.state
    const remaining = { ...state.remaining }
    if (this.deadlineMono !== null) remaining[this.turn] = this.remaining(this.turn)!
    this.deadlineMono = null
    this.document = committed(this.document, { ...state, remaining, deadlineWallMs: null,
      status: interrupted ? 'interrupted' : 'suspended' })
    return this.document
  }

  resume(): GameDocument {
    if (this.state.status !== 'suspended' && this.state.status !== 'interrupted') throw new Error('Game is not suspended')
    const state = this.state
    const left = state.remaining[this.turn]
    this.deadlineMono = state.initialMs === null ? null : this.clock.monotonic() + left
    this.document = committed(this.document, { ...state, status: 'active',
      deadlineWallMs: state.initialMs === null ? null : this.clock.wall() + left })
    return this.document
  }

  /** Adopt the conflict copy ID without discarding moves made while its save was in flight. */
  adoptSaved(saved: GameDocument, submitted: GameDocument): GameDocument {
    if (saved.id !== submitted.id && this.document.id === submitted.id) {
      this.document = { ...this.document, id: saved.id,
        revision: saved.revision + this.document.revision - submitted.revision }
    }
    return this.document
  }

  resign(): GameDocument {
    if (this.state.status === 'finished') return this.document
    if (this.tick()) return this.document
    const winner = opposite(this.state.humanColor)
    this.finish(winner === 'w' ? '1-0' : '0-1', 'resignation')
    return this.document
  }

  abandon(): GameDocument {
    if (this.state.status === 'finished') return this.document
    if (this.tick()) return this.document
    this.finish(null, 'abandoned')
    return this.document
  }
}
