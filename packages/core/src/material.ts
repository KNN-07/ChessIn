import type { Chess, Color } from 'chess.js'

/** The material-only timeout rule used by python-chess Board.has_insufficient_material.
 * It is deliberately not a general dead-position solver. */
export function hasInsufficientMaterial(chess: Chess, color: Color): boolean {
  const pieces: { color: Color; type: string; dark: boolean }[] = []
  const board = chess.board()
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = board[rank][file]
      if (piece) pieces.push({ color: piece.color, type: piece.type, dark: (rank + file) % 2 === 1 })
    }
  }
  const own = pieces.filter(piece => piece.color === color && piece.type !== 'k')
  if (own.some(piece => piece.type === 'p' || piece.type === 'r' || piece.type === 'q')) return false
  if (own.length === 0) return true
  if (own.some(piece => piece.type === 'n')) {
    return own.length === 1 && own[0].type === 'n' &&
      !pieces.some(piece => piece.color !== color && piece.type !== 'k' && piece.type !== 'q')
  }
  // Bishops of one color complex cannot mate without any pawn or knight on either side.
  const bishops = pieces.filter(piece => piece.type === 'b')
  return !pieces.some(piece => piece.type === 'p' || piece.type === 'n') &&
    bishops.every(piece => piece.dark === bishops[0].dark)
}
