import { describe, expect, it } from 'vitest'
import { createGame, getPosition } from '@chessin/core/game'
import { hasInsufficientMaterial } from '@chessin/core/material'
import { Chess } from 'chess.js'
import { PlaySession, type PlayClock, type PlayOptions } from './play-session'

function fixture() {
  let mono = 1000, wall = 1_800_000_000_000
  const clock: PlayClock = { monotonic: () => mono, wall: () => wall }
  const advance = (milliseconds: number) => { mono += milliseconds; wall += milliseconds }
  const sleep = (milliseconds: number) => { wall += milliseconds }
  const options: PlayOptions = {
    humanColor: 'w', provider: 'local', profile: 'lite-single', engineId: 'stockfish',
    engineName: 'Stockfish', engineVersion: '19', settings: { strength: { kind: 'skill', value: 10 }, multiPv: 1 },
    initialMs: 180_000, incrementMs: 2000,
  }
  return { clock, advance, sleep, options }
}

describe('authoritative play session', () => {
  it('charges until legal acceptance, awards increment once, rejects illegal and stale moves', () => {
    const { clock, advance, options } = fixture()
    const game = PlaySession.begin(options, clock)
    advance(4000)
    expect(() => game.move('e2e5', 'w')).toThrow(/Illegal/)
    expect(game.remaining('w')).toBe(176_000)
    const oldRevision = game.game.revision
    game.move('e2e4', 'w')
    expect(game.state.remaining.w).toBe(178_000)
    expect(game.remaining('b')).toBe(180_000)
    expect(() => game.move('e7e5', 'b', oldRevision)).toThrow(/Stale/)
    expect(game.state.remaining.w).toBe(178_000)
    expect(getPosition(game.game).moves).toEqual(['e2e4'])
  })

  it('rejects a late engine bestmove and does not let wall-clock sleep extend a deadline', () => {
    const { clock, advance, sleep, options } = fixture()
    const session = PlaySession.begin(options, clock)
    session.move('e2e4', 'w')
    const revision = session.game.revision
    sleep(180_001) // performance.now may stop advancing while a device sleeps.
    expect(() => session.move('e7e5', 'b', revision)).toThrow(/flag fell/)
    expect(session.state).toMatchObject({ status: 'finished', result: '1-0', reason: 'timeout' })
    expect(getPosition(session.game).moves).toEqual(['e2e4'])
    advance(5000)
    expect(() => session.move('e7e5', 'b', revision)).toThrow(/Stale/)
  })

  it('debits an interruption once, freezes both clocks, and requires explicit resume', () => {
    const { clock, advance, options } = fixture()
    const session = PlaySession.begin(options, clock)
    advance(6500)
    session.suspend(true)
    expect(session.state.status).toBe('interrupted')
    expect(session.remaining('w')).toBe(173_500)
    advance(30_000)
    expect(session.remaining('w')).toBe(173_500)
    expect(() => session.move('e2e4', 'w')).toThrow(/Stale/)
    session.resume()
    advance(3500)
    session.move('e2e4', 'w')
    expect(session.state.remaining.w).toBe(172_000)
    expect(session.state.remaining.b).toBe(180_000)
  })

  it('reopens saved active games by wall deadline and suspends or flags before move input', () => {
    const { clock, advance, options } = fixture()
    const active = PlaySession.begin(options, clock)
    advance(8000)
    const loaded = PlaySession.restore(structuredClone(active.game), clock)
    expect(loaded.state.status).toBe('suspended')
    expect(loaded.remaining('w')).toBe(172_000)
    advance(200_000)
    expect(loaded.remaining('w')).toBe(172_000)
    const expired = PlaySession.restore(structuredClone(active.game), clock)
    expect(expired.state).toMatchObject({ status: 'finished', result: '0-1', reason: 'timeout' })
  })

  it('automatically draws on threefold repetition using full move history', () => {
    const { clock, options } = fixture()
    const session = PlaySession.begin({ ...options, initialMs: null, incrementMs: 0 }, clock)
    for (const move of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) {
      session.move(move, session.turn)
    }
    expect(session.state).toMatchObject({ result: '1/2-1/2', reason: 'threefold repetition', status: 'finished' })
  })

  it('draws timeout if the non-flagging side has only a bare king', () => {
    const { clock, options } = fixture()
    const initial = PlaySession.begin(options, clock)
    const position = createGame('7k/8/8/8/8/8/P7/7K w - - 0 1')
    const restored = PlaySession.restore({ ...position, play: initial.state }, { ...clock, wall: () => clock.wall() + 180_001 })
    expect(restored.state).toMatchObject({ result: '1/2-1/2', reason: 'timeout — insufficient material' })
  })
})

describe('material-only timeout rule', () => {
  it('does not claim two knights can never mate, and handles mixed-color bishops', () => {
    expect(hasInsufficientMaterial(new Chess('7k/8/8/8/8/8/8/6NK w - - 0 1'), 'w')).toBe(true)
    expect(hasInsufficientMaterial(new Chess('7k/8/8/8/8/8/8/5NNK w - - 0 1'), 'w')).toBe(false)
    expect(hasInsufficientMaterial(new Chess('7k/8/8/8/8/8/8/5BNK w - - 0 1'), 'w')).toBe(false)
    expect(hasInsufficientMaterial(new Chess('7k/8/8/8/8/8/8/5B1K w - - 0 1'), 'w')).toBe(true)
    expect(hasInsufficientMaterial(new Chess('7k/6n1/8/8/8/8/8/6NK w - - 0 1'), 'w')).toBe(false)
    expect(hasInsufficientMaterial(new Chess('7k/6q1/8/8/8/8/8/6NK w - - 0 1'), 'w')).toBe(true)
    expect(hasInsufficientMaterial(new Chess('1b5k/8/8/8/8/8/8/5B1K w - - 0 1'), 'w')).toBe(false)
  })
})
