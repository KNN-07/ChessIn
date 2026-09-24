import { Chess, DEFAULT_POSITION, type Square } from 'chess.js'
import { getPosition, type GameDocument } from './game.js'

export interface Opening {
  name: string
  eco: string
}

/** Small, original set of standard opening landmarks, not an external opening database. */
const LINES: ReadonlyArray<readonly [string, string, string]> = [
  ['King’s Pawn Game', 'C20', 'e4 e5'],
  ['Vienna Game', 'C25', 'e4 e5 Nc3'],
  ['King’s Gambit', 'C30', 'e4 e5 f4'],
  ['Petrov Defense', 'C42', 'e4 e5 Nf3 Nf6'],
  ['Philidor Defense', 'C41', 'e4 e5 Nf3 d6'],
  ['Italian Game', 'C50', 'e4 e5 Nf3 Nc6 Bc4'],
  ['Giuoco Piano', 'C53', 'e4 e5 Nf3 Nc6 Bc4 Bc5'],
  ['Ruy Lopez', 'C60', 'e4 e5 Nf3 Nc6 Bb5'],
  ['Berlin Defense', 'C65', 'e4 e5 Nf3 Nc6 Bb5 Nf6'],
  ['Scotch Game', 'C45', 'e4 e5 Nf3 Nc6 d4'],
  ['Four Knights Game', 'C47', 'e4 e5 Nf3 Nc6 Nc3 Nf6'],
  ['Sicilian Defense', 'B20', 'e4 c5'],
  ['Sicilian Defense: Alapin Variation', 'B22', 'e4 c5 c3'],
  ['Sicilian Defense: Closed Variation', 'B23', 'e4 c5 Nc3'],
  ['Sicilian Defense: Open Variation', 'B32', 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4'],
  ['Sicilian Defense: Dragon Variation', 'B70', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6'],
  ['Sicilian Defense: Najdorf Variation', 'B90', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'],
  ['French Defense', 'C00', 'e4 e6'],
  ['French Defense: Advance Variation', 'C02', 'e4 e6 d4 d5 e5'],
  ['French Defense: Exchange Variation', 'C01', 'e4 e6 d4 d5 exd5 exd5'],
  ['French Defense: Tarrasch Variation', 'C03', 'e4 e6 d4 d5 Nd2'],
  ['French Defense: Winawer Variation', 'C15', 'e4 e6 d4 d5 Nc3 Bb4'],
  ['Caro-Kann Defense', 'B10', 'e4 c6'],
  ['Caro-Kann Defense: Advance Variation', 'B12', 'e4 c6 d4 d5 e5'],
  ['Scandinavian Defense', 'B01', 'e4 d5'],
  ['Alekhine Defense', 'B02', 'e4 Nf6'],
  ['Pirc Defense', 'B07', 'e4 d6 d4 Nf6 Nc3 g6'],
  ['Modern Defense', 'B06', 'e4 g6'],
  ['Queen’s Pawn Game', 'D00', 'd4 d5'],
  ['Indian Game', 'A45', 'd4 Nf6'],
  ['Dutch Defense', 'A80', 'd4 f5'],
  ['Queen’s Gambit', 'D06', 'd4 d5 c4'],
  ['Queen’s Gambit Declined', 'D30', 'd4 d5 c4 e6'],
  ['Queen’s Gambit Declined', 'D30', 'd4 d5 c4 e6 Nf3 Nf6'],
  ['Queen’s Gambit Accepted', 'D20', 'd4 d5 c4 dxc4'],
  ['Slav Defense', 'D10', 'd4 d5 c4 c6'],
  ['London System', 'D02', 'd4 d5 Nf3 Nf6 Bf4'],
  ['King’s Indian Defense', 'E60', 'd4 Nf6 c4 g6 Nc3 Bg7'],
  ['Nimzo-Indian Defense', 'E20', 'd4 Nf6 c4 e6 Nc3 Bb4'],
  ['Queen’s Indian Defense', 'E12', 'd4 Nf6 c4 e6 Nf3 b6'],
  ['Grünfeld Defense', 'D70', 'd4 Nf6 c4 g6 Nc3 d5'],
  ['Catalan Opening', 'E00', 'd4 Nf6 c4 e6 g3'],
  ['Benoni Defense', 'A56', 'd4 Nf6 c4 c5'],
  ['English Opening', 'A10', 'c4'],
  ['English Opening: Symmetrical Variation', 'A30', 'c4 c5'],
  ['Réti Opening', 'A04', 'Nf3'],
  ['King’s Indian Attack', 'A07', 'Nf3 d5 g3'],
]

// Ignore clocks (which depend on move order), but keep the side to move, castling
// and legal en-passant rights: these distinguish genuinely different positions.
function positionKey(chess: Chess): string {
  return chess.fen().split(' ').slice(0, 4).join(' ')
}

const landmarks = new Map<string, { opening: Opening; depth: number }>()
for (const [name, eco, line] of LINES) {
  const chess = new Chess()
  const moves = line.split(' ')
  for (const san of moves) chess.move(san)
  landmarks.set(positionKey(chess), { opening: { name, eco }, depth: moves.length })
}
const standardRootKey = positionKey(new Chess(DEFAULT_POSITION))

/** Match actual positions on the selected root-to-node path, including transpositions. */
export function detectOpening(game: GameDocument, nodeId = game.currentId): Opening | null {
  const { initialFen, moves } = getPosition(game, nodeId)
  const chess = new Chess(initialFen)
  // A custom root is not assumed to have the history of the initial position.
  // Its subsequent positions can still match a known landmark exactly.
  let best: { opening: Opening; depth: number } | undefined
  for (const uci of moves) {
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    const match = landmarks.get(positionKey(chess))
    if (match && (!best || match.depth > best.depth)) best = match
  }
  return best?.opening ?? null
}

const pieceNames = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' } as const
const center = ['d4', 'e4', 'd5', 'e5'] as const
const homeMinorSquares: Record<string, true> = { b1: true, c1: true, f1: true, g1: true, b8: true, c8: true, f8: true, g8: true }

/** Describe only facts visible in the played move and resulting board, never engine judgments. */
export function moveCommentary(game: GameDocument, nodeId = game.currentId): string {
  if (nodeId === game.rootId) return ''
  const node = game.nodes[nodeId]
  if (!node?.parentId || !node.uci) throw new Error(`Unknown game move: ${nodeId}`)
  const { initialFen, moves: history } = getPosition(game, node.parentId)
  const chess = new Chess(initialFen)
  for (const uci of history) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  const uci = node.uci
  const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  const actor = move.color === 'w' ? 'White' : 'Black'
  const facts: string[] = []

  if (move.flags.includes('k') || move.flags.includes('q')) {
    facts.push(`${actor} castles ${move.flags.includes('k') ? 'kingside' : 'queenside'}.`)
  } else if (move.captured) {
    facts.push(move.flags.includes('e')
      ? `${actor}’s pawn captures a pawn en passant, landing on ${move.to}.`
      : `${actor}’s ${pieceNames[move.piece]} captures a ${pieceNames[move.captured]} on ${move.to}.`)
  } else if (move.piece === 'p') {
    facts.push(`${actor} advances a pawn to ${move.to}.`)
  } else {
    const originalMinor = (move.piece === 'n' || move.piece === 'b') && homeMinorSquares[move.from] &&
      initialFen.startsWith(`${standardRootKey} `) &&
      history.every(previous => previous.slice(0, 2) !== move.from && previous.slice(2, 4) !== move.from)
    facts.push(`${actor} ${originalMinor ? 'develops' : 'moves'} a ${pieceNames[move.piece]} from ${move.from} to ${move.to}.`)
  }

  if (move.promotion) facts.push(`The pawn promotes to a ${pieceNames[move.promotion]}.`)
  if (move.piece === 'p' && center.includes(move.to as typeof center[number])) {
    facts.push(`The pawn occupies ${move.to}, a central square.`)
  } else if (move.piece === 'n' || move.piece === 'b') {
    const attacked = center.filter(square => chess.attackers(square as Square, move.color).includes(move.to))
    if (attacked.length) facts.push(`The ${pieceNames[move.piece]} attacks ${attacked.join(' and ')}.`)
  }
  if (chess.isCheckmate()) facts.push('This is checkmate.')
  else if (chess.isCheck()) facts.push('This gives check.')
  return facts.join(' ')
}
