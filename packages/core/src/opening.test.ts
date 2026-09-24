import { describe, expect, it } from 'vitest'
import { appendMove, createGame, importFen, selectNode } from './game.js'
import { detectOpening } from './opening.js'

function play(...moves: string[]) {
  let game = createGame()
  for (const move of moves) game = appendMove(game, move)
  return game
}

describe('offline opening detection', () => {
  it('recognizes named openings on the selected path and favors the most specific reached landmark', () => {
    const sicilian = play('e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6')
    expect(detectOpening(sicilian)).toEqual({ name: 'Sicilian Defense: Najdorf Variation', eco: 'B90' })
    const italian = play('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5')
    expect(detectOpening(italian)).toEqual({ name: 'Giuoco Piano', eco: 'C53' })
    expect(detectOpening(italian, italian.nodes[italian.currentId].parentId!)).toEqual({ name: 'Italian Game', eco: 'C50' })
    expect(detectOpening(play('d4', 'd5', 'c4', 'dxc4'))).toEqual({ name: 'Queen’s Gambit Accepted', eco: 'D20' })
    expect(detectOpening(play('e4', 'c6', 'd4', 'd5', 'e5'))).toEqual({ name: 'Caro-Kann Defense: Advance Variation', eco: 'B12' })
  })

  it('recognizes equivalent positions reached by different legal move orders', () => {
    expect(detectOpening(play('e4', 'e5', 'Bc4', 'Nc6', 'Nf3'))).toEqual({ name: 'Italian Game', eco: 'C50' })
    const direct = play('d4', 'd5', 'c4', 'e6', 'Nf3', 'Nf6')
    const transposed = play('d4', 'Nf6', 'c4', 'e6', 'Nf3', 'd5')
    expect(detectOpening(direct)).toEqual({ name: 'Queen’s Gambit Declined', eco: 'D30' })
    expect(detectOpening(transposed)).toEqual(detectOpening(direct))
  })

  it('uses the selected variation rather than a sibling, future move or untrusted PGN header', () => {
    const root = createGame()
    const white = appendMove(root, 'e4')
    const e4 = white.currentId
    const main = appendMove(white, 'c5')
    const sicilian = main.currentId
    const branch = appendMove(main, 'e5', e4)
    const pawnGame = branch.currentId
    branch.headers.Opening = 'Ruy Lopez'
    branch.headers.ECO = 'C60'
    expect(detectOpening(branch)).toEqual({ name: 'King’s Pawn Game', eco: 'C20' })
    expect(detectOpening(branch, sicilian)).toEqual({ name: 'Sicilian Defense', eco: 'B20' })
    expect(detectOpening(selectNode(branch, e4))).toBeNull()
    expect(detectOpening(branch, pawnGame)).toEqual({ name: 'King’s Pawn Game', eco: 'C20' })
    expect(detectOpening(branch, root.rootId)).toBeNull()
  })

  it('does not infer an opening for an unknown line or unrelated custom starting position', () => {
    expect(detectOpening(play('a3', 'h6', 'b3'))).toBeNull()
    const custom = importFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1')
    expect(detectOpening(custom)).toBeNull()
    expect(detectOpening(appendMove(custom, 'e4'))).toBeNull()
  })
})

