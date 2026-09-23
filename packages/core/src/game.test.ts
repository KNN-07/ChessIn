import { describe, expect, it } from 'vitest'
import { appendMove, createGame, deleteVariation, exportFen, getPosition, importFen, promoteVariation, reconstruct, selectNode, validatePosition } from './game.js'

describe('game tree', () => {
  it('retains the original continuation when branching and revisits rather than duplicating moves', () => {
    const root = createGame()
    const first = appendMove(root, 'e4')
    const e4 = first.currentId
    const main = appendMove(first, 'e5')
    const e5 = main.currentId
    const alternative = appendMove(main, 'c5', e4)
    const c5 = alternative.currentId

    expect(root.nodes[root.rootId].childIds).toEqual([])
    expect(main.nodes[e4].childIds).toEqual([e5])
    expect(alternative.nodes[e4].childIds).toEqual([e5, c5])
    expect(appendMove(alternative, 'c7c5', e4).currentId).toBe(c5)
    expect(Object.keys(appendMove(alternative, 'c5', e4).nodes)).toHaveLength(4)
    expect(getPosition(alternative)).toEqual({ initialFen: root.rootFen, moves: ['e2e4', 'c7c5'] })
    expect(promoteVariation(alternative, c5).nodes[e4].childIds).toEqual([c5, e5])
    expect(deleteVariation(alternative, e5).nodes[e4].childIds).toEqual([c5])
    expect(deleteVariation(alternative, c5).currentId).toBe(e4)
    expect(() => deleteVariation(alternative, root.rootId)).toThrow(/root/)
    expect(selectNode(alternative, e5).currentId).toBe(e5)
    expect(alternative.revision).toBeGreaterThan(main.revision)
  })

  it('uses explicit underpromotion and entire move history for the repetition rule', () => {
    const initial = importFen('7k/P7/8/8/8/8/8/7K w - - 0 1')
    const promoted = appendMove(initial, 'a7a8n')
    expect(reconstruct(promoted).get('a8')?.type).toBe('n')
    expect(exportFen(promoted)).toMatch(/^N6k\//)
    expect(() => appendMove(initial, 'a7a8')).toThrow(/Illegal move/)

    let repeated = createGame()
    for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']) {
      repeated = appendMove(repeated, move)
    }
    expect(reconstruct(repeated).isThreefoldRepetition()).toBe(true)
    expect(getPosition(repeated).moves).toHaveLength(8)
  })

  it('rejects impossible roots, illegal history and invalid path syntax', () => {
    expect(() => importFen('8/8/8/8/8/8/4k3/4K3 w - - 0 1')).toThrow()
    expect(() => importFen('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1')).toThrow(/non-moving king/)
    expect(() => importFen('4k3/8/8/8/8/8/8/4K3 w K - 0 1')).toThrow(/Castling rights/)
    expect(() => importFen('4k3/8/8/8/8/8/8/4K3 w - d6 0 1')).toThrow(/En-passant/)
    expect(() => validatePosition({ initialFen: createGame().rootFen, moves: ['e2e5'] })).toThrow(/ply 1/)
    expect(() => validatePosition({ initialFen: createGame().rootFen, moves: ['e2e4\ngo'] })).toThrow(/ply 1/)
    const game = createGame()
    expect(() => appendMove(game, 'e5')).toThrow(/Illegal move/)
    expect(game.revision).toBe(0)
  })

  it('replays castling and en passant as legal coordinate moves', () => {
    let game = createGame()
    for (const move of ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6', 'e7d6', 'g1f3', 'g8f6', 'f1e2', 'f8e7', 'e1g1']) {
      game = appendMove(game, move)
    }
    expect(reconstruct(game).get('g1')?.type).toBe('k')
    expect(game.nodes[game.currentId].san).toBe('O-O')
  })
})
