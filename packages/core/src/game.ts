import { Chess, DEFAULT_POSITION, type Square } from 'chess.js'

export interface PositionSpec {
  initialFen: string
  moves: string[]
}

export interface GameNode {
  id: string
  parentId: string | null
  childIds: string[]
  fen: string
  san: string | null
  uci: string | null
  comments: string[]
  nags: number[]
}

export interface GameDocument {
  schemaVersion: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  headers: Record<string, string>
  rootFen: string
  rootId: string
  currentId: string
  nodes: Record<string, GameNode>
  revision: number
  /** Timed play persists its independently versioned state with the game. */
  play?: unknown
}

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/

function checkedFen(fen: string): Chess {
  const chess = new Chess(fen)
  const [, , castling, enPassant, halfmove] = fen.split(/\s+/)
  for (const [right, king, rook, color] of [
    ['K', 'e1', 'h1', 'w'], ['Q', 'e1', 'a1', 'w'],
    ['k', 'e8', 'h8', 'b'], ['q', 'e8', 'a8', 'b'],
  ] as const) {
    if (castling.includes(right) &&
        (chess.get(king)?.type !== 'k' || chess.get(king)?.color !== color ||
         chess.get(rook)?.type !== 'r' || chess.get(rook)?.color !== color)) {
      throw new Error('Castling rights require a king and rook on their starting squares')
    }
  }
  if (enPassant !== '-') {
    const file = enPassant[0]
    const pushedPawn = `${file}${chess.turn() === 'w' ? '5' : '4'}` as Square
    const origin = `${file}${chess.turn() === 'w' ? '7' : '2'}` as Square
    const pawn = chess.get(pushedPawn)
    if (halfmove !== '0' || pawn?.type !== 'p' || pawn.color === chess.turn() ||
        chess.get(enPassant as Square) || chess.get(origin)) {
      throw new Error('En-passant square requires the immediately preceding legal pawn push')
    }
  }
  const white = chess.findPiece({ type: 'k', color: 'w' })[0]
  const black = chess.findPiece({ type: 'k', color: 'b' })[0]
  if (!white || !black) throw new Error('Position must contain both kings')
  if (Math.abs(white.charCodeAt(0) - black.charCodeAt(0)) <= 1 &&
      Math.abs(Number(white[1]) - Number(black[1])) <= 1) {
    throw new Error('Adjacent kings are not a legal position')
  }
  const nonMovingKing = chess.turn() === 'w' ? black : white
  if (chess.attackers(nonMovingKing, chess.turn()).length > 0) {
    throw new Error('The non-moving king cannot be in check')
  }
  return chess
}

/** Validate a FEN and replay the entire legal UCI history, preserving repetition. */
export function validatePosition(position: PositionSpec): Chess {
  const chess = checkedFen(position.initialFen)
  for (let index = 0; index < position.moves.length; index++) {
    const uci = position.moves[index]
    if (!UCI_MOVE.test(uci)) throw new Error(`Invalid UCI move at ply ${index + 1}`)
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    } catch {
      throw new Error(`Illegal move at ply ${index + 1}: ${uci}`)
    }
  }
  return chess
}

export function createGame(fen = DEFAULT_POSITION, title = 'New Analysis'): GameDocument {
  const rootFen = checkedFen(fen).fen({ forceEnpassantSquare: true })
  const id = crypto.randomUUID()
  const rootId = crypto.randomUUID()
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id,
    title,
    createdAt: now,
    updatedAt: now,
    headers: {},
    rootFen,
    rootId,
    currentId: rootId,
    nodes: {
      [rootId]: { id: rootId, parentId: null, childIds: [], fen: rootFen, san: null, uci: null, comments: [], nags: [] },
    },
    revision: 0,
  }
}

export function importFen(fen: string): GameDocument {
  return createGame(fen)
}

function requireNode(game: GameDocument, id: string): GameNode {
  const node = game.nodes[id]
  if (!node) throw new Error(`Unknown game node: ${id}`)
  return node
}

function pathNodes(game: GameDocument, nodeId: string): GameNode[] {
  const path: GameNode[] = []
  const seen = new Set<string>()
  let node = requireNode(game, nodeId)
  while (node.id !== game.rootId) {
    if (seen.has(node.id) || !node.parentId) throw new Error('Invalid game tree')
    seen.add(node.id)
    path.push(node)
    node = requireNode(game, node.parentId)
  }
  path.reverse()
  return path
}

export function getPosition(game: GameDocument, nodeId = game.currentId): PositionSpec {
  return { initialFen: game.rootFen, moves: pathNodes(game, nodeId).map(node => {
    if (!node.uci) throw new Error('Invalid game tree: move missing')
    return node.uci
  }) }
}

export function reconstruct(game: GameDocument, nodeId = game.currentId): Chess {
  return validatePosition(getPosition(game, nodeId))
}

export function exportFen(game: GameDocument, nodeId = game.currentId): string {
  return reconstruct(game, nodeId).fen({ forceEnpassantSquare: true })
}

function changed(game: GameDocument, updates: Partial<GameDocument>): GameDocument {
  return { ...game, ...updates, revision: game.revision + 1, updatedAt: new Date().toISOString() }
}

export function selectNode(game: GameDocument, nodeId: string): GameDocument {
  requireNode(game, nodeId)
  if (nodeId === game.currentId) return game
  return changed(game, { currentId: nodeId })
}

/** Append a legal SAN or UCI move at the selected node, or revisit an existing child. */
export function appendMove(game: GameDocument, move: string, nodeId = game.currentId): GameDocument {
  const parent = requireNode(game, nodeId)
  const chess = reconstruct(game, nodeId)
  let played
  try {
    played = UCI_MOVE.test(move)
      ? chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
      : chess.move(move)
  } catch {
    throw new Error(`Illegal move: ${move}`)
  }
  const uci = `${played.from}${played.to}${played.promotion ?? ''}`
  const existingId = parent.childIds.find(id => requireNode(game, id).uci === uci)
  if (existingId) return selectNode(game, existingId)

  const id = crypto.randomUUID()
  const node: GameNode = {
    id, parentId: parent.id, childIds: [], fen: chess.fen({ forceEnpassantSquare: true }),
    san: played.san, uci, comments: [], nags: [],
  }
  return changed(game, {
    currentId: id,
    nodes: {
      ...game.nodes,
      [parent.id]: { ...parent, childIds: [...parent.childIds, id] },
      [id]: node,
    },
  })
}

export function promoteVariation(game: GameDocument, nodeId: string): GameDocument {
  const node = requireNode(game, nodeId)
  if (!node.parentId) throw new Error('The root has no variation to promote')
  const parent = requireNode(game, node.parentId)
  const index = parent.childIds.indexOf(nodeId)
  if (index < 0) throw new Error('Invalid game tree')
  if (index === 0) return game
  return changed(game, {
    nodes: { ...game.nodes, [parent.id]: {
      ...parent, childIds: [nodeId, ...parent.childIds.filter(id => id !== nodeId)],
    } },
  })
}

/** Caller must obtain user confirmation before deleting a branch. */
export function deleteVariation(game: GameDocument, nodeId: string): GameDocument {
  const node = requireNode(game, nodeId)
  if (!node.parentId) throw new Error('Cannot delete the root position')
  const parent = requireNode(game, node.parentId)
  if (!parent.childIds.includes(nodeId)) throw new Error('Invalid game tree')
  const removed = new Set<string>()
  const pending = [nodeId]
  while (pending.length) {
    const id = pending.pop()!
    if (removed.has(id)) throw new Error('Invalid game tree')
    removed.add(id)
    pending.push(...requireNode(game, id).childIds)
  }
  const nodes = { ...game.nodes }
  for (const id of removed) delete nodes[id]
  nodes[parent.id] = { ...parent, childIds: parent.childIds.filter(id => id !== nodeId) }
  return changed(game, { nodes, currentId: removed.has(game.currentId) ? parent.id : game.currentId })
}
