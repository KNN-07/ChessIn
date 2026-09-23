import { describe, expect, it } from 'vitest'
import { deleteVariation, getPosition, promoteVariation, reconstruct } from './game.js'
import { exportPgn, importPgn } from './pgn.js'

describe('PGN adapter', () => {
  it('imports recursive variations from the replaced move, and exports a reversible tree', () => {
    const source = '[White "A"]\n[Black "B"]\n[Date "2025.04.02"]\n\n1. e4 {main} (1. d4 d5 (1... Nf6)) e5 2. Nf3 *'
    const [game] = importPgn(source)
    const root = game.nodes[game.rootId]
    const [e4, d4] = root.childIds
    const d5 = game.nodes[d4].childIds[0]
    const nf6 = game.nodes[d4].childIds[1]
    expect(game.nodes[e4].comments).toContain('main')
    expect(game.headers.Date).toBe('2025.04.02')
    expect(game.nodes[d5].san).toBe('d5')
    expect(game.nodes[nf6].san).toBe('Nf6')
    expect(getPosition(game, nf6).moves).toEqual(['d2d4', 'g8f6'])
    expect(getPosition(game).moves).toEqual(['e2e4', 'e7e5', 'g1f3'])

    const promoted = promoteVariation(game, d4)
    const serialized = exportPgn(promoted)
    const [roundTrip] = importPgn(serialized)
    expect(roundTrip.nodes[roundTrip.nodes[roundTrip.rootId].childIds[0]].san).toBe('d4')
    expect(Object.values(roundTrip.nodes).some(node => node.comments.includes('main'))).toBe(true)
    expect(Object.values(roundTrip.nodes).map(node => node.san)).toContain('Nf6')
    expect(reconstruct(roundTrip).fen()).toBe(reconstruct(promoted, d5).fen())
    const removed = deleteVariation(promoted, e4)
    expect(exportPgn(removed)).not.toContain('e4')
  })

  it('preserves NAGs, escaped headers, root comments and black-to-move numbering', () => {
    const fen = '4k3/8/8/8/8/8/8/4K3 b - - 0 21'
    const text = `[Event "A \\"quote\\" and \\\\ backslash"]\n[FEN "${fen}"]\n[SetUp "1"]\n\n{before} 21... Kd7 $1 {after} *`
    const [game] = importPgn(text)
    expect(game.nodes[game.rootId].comments).toContain('before')
    expect(game.nodes[game.currentId].nags).toEqual([1])
    expect(game.nodes[game.currentId].comments).toContain('after')
    const output = exportPgn(game)
    expect(output).toContain('21... Kd7 $1 {after}')
    expect(importPgn(output)[0].headers.Event).toBe(game.headers.Event)
  })

  it('imports multiple games atomically and reports illegal variation context', () => {
    const valid = '1. e4 e5 *'
    expect(importPgn(`${valid}\n\n1. d4 d5 *`)).toHaveLength(2)
    expect(() => importPgn(`${valid}\n\n1. e4 (1. d5) e5 *`)).toThrow(/Game 2, variation .*ply 1: illegal move d5/)
    expect(() => importPgn('[Variant "Crazyhouse"]\n\n*')).toThrow(/unsupported chess variant/)
    expect(() => importPgn('[FEN "8/8/8/8/8/8/8/8 w - - 0 1"]\n\n*')).toThrow(/Game 1: invalid starting FEN/)
    expect(() => importPgn(' '.repeat(2 * 1024 * 1024 + 1))).toThrow(/2 MiB/)
    expect(() => importPgn(Array(101).fill('[Event "g"]\n\n*').join('\n\n'))).toThrow(/100 games/)
  })
})
