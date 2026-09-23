import { Chess } from 'chess.js'
import type { EngineScore, EngineSettings, PositionSpec } from './engine.js'
import { getPosition, reconstruct, type GameDocument } from './game.js'

export const REVIEW_ALGORITHM_VERSION = 'chessin-review-v1' as const
export type ReviewLabel = 'Forced' | 'Brilliant' | 'Great' | 'Best' | 'Excellent' | 'Good' | 'Inaccuracy' | 'Mistake' | 'Blunder' | 'Uncertain'
export type Candidate = { move: string; score: EngineScore; pv: string[] }
export type DepthSnapshot = { depth: number; candidates: Candidate[] }
export type ReviewSignature = {
  algorithmVersion: typeof REVIEW_ALGORITHM_VERSION
  gameId: string
  revision: number
  mainline: string[]
  /** Immutable tree content distinguishes edits from selection-only revision changes. */
  treeVersion: string
  engineId: string
  engineName: string
  engineVersion: string
  provider: 'local' | 'remote'
  settings: EngineSettings
  depth: number
  moveTimeMs: number
}
export type ReviewMove = {
  nodeId: string
  san: string
  side: 'white' | 'black'
  label: ReviewLabel
  actualDepth: number
  bestDepth?: number
  playedDepth?: number
  lossCp?: number
  best?: Candidate
  played?: Candidate
  runnerUp?: Candidate
  whiteScore?: EngineScore
  bestSan?: string[]
  explanation: string
  terminal?: 'checkmate' | 'stalemate' | 'draw'
}
export type ReviewReport = {
  signature: ReviewSignature
  moves: Record<string, ReviewMove>
  status: 'paused' | 'completed' | 'cancelled'
}

export function mainlineNodes(game: GameDocument): string[] {
  const ids: string[] = []
  const visited = new Set<string>()
  let parent = game.nodes[game.rootId]
  while (parent?.childIds.length) {
    const id = parent.childIds[0]
    if (visited.has(id) || !game.nodes[id]?.uci) throw new Error('Invalid mainline')
    visited.add(id)
    ids.push(id)
    parent = game.nodes[id]
  }
  return ids
}

export function reviewSignature(game: GameDocument, engine: { id: string; name: string; buildVersion: string }, provider: 'local' | 'remote', settings: EngineSettings, depth: number, moveTimeMs: number): ReviewSignature {
  return {
    algorithmVersion: REVIEW_ALGORITHM_VERSION, gameId: game.id, revision: game.revision,
    treeVersion: JSON.stringify([game.rootFen, game.rootId, game.nodes]),
    mainline: mainlineNodes(game).map(id => game.nodes[id].uci!),
    engineId: engine.id, engineName: engine.name, engineVersion: engine.buildVersion,
    provider, settings: { ...settings, strength: { kind: 'full' } }, depth, moveTimeMs,
  }
}

export function matchesReview(report: ReviewReport | undefined, signature: ReviewSignature): boolean {
  if (!report) return false
  const { revision: _old, ...oldIdentity } = report.signature
  const { revision: _next, ...nextIdentity } = signature
  return JSON.stringify(oldIdentity) === JSON.stringify(nextIdentity)
}

export function terminalAssessment(position: Chess): 'checkmate' | 'stalemate' | 'draw' | undefined {
  if (position.isCheckmate()) return 'checkmate'
  if (position.isStalemate()) return 'stalemate'
  if (position.isDraw()) return 'draw'
  return undefined
}


/** All scores in this module are relative to the side about to make the reviewed move. */
export function moverLoss(best: EngineScore, played: EngineScore): number | undefined {
  if (best.bound || played.bound) return undefined
  if (best.kind === 'cp' && played.kind === 'cp') return Math.max(0, best.value - played.value)
  if (best.kind === 'mate' && played.kind === 'mate' && best.value > 0 && played.value > 0) return 0
  if (best.kind === 'mate' && played.kind === 'mate' && best.value < 0 && played.value < 0) return 0
  if (best.kind === 'mate' && best.value > 0 && (played.kind !== 'mate' || played.value <= 0)) return 1000
  if (played.kind === 'mate' && played.value <= 0 && !(best.kind === 'mate' && best.value < 0)) return 1000
  return 0
}

export function toWhiteScore(score: EngineScore, side: 'white' | 'black'): EngineScore {
  if (side === 'white') return { ...score }
  return { ...score, value: -score.value, bound: score.bound === 'lower' ? 'upper' : score.bound === 'upper' ? 'lower' : undefined }
}

function material(chess: Chess, side: 'w' | 'b'): number {
  const values: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
  let balance = 0
  for (const row of chess.board()) for (const piece of row) if (piece) balance += (piece.color === side ? 1 : -1) * values[piece.type]
  return balance
}

/** Deliberately conservative, replayed-material heuristic; never a positional claim. */
export function isEngineBackedSacrifice(position: PositionSpec, playedUci: string, pv: string[]): boolean {
  if (pv[0] !== playedUci || pv.length < 2) return false
  let chess: Chess
  try { chess = new Chess(position.initialFen); for (const uci of position.moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }) } catch { return false }
  const side = chess.turn()
  const baseline = material(chess, side)
  let movedSquare = playedUci.slice(2, 4)
  let movedPiece: string | undefined
  let capturedAt = -1
  let qualifyingReply = false
  for (let ply = 0; ply < Math.min(pv.length, 6); ply++) {
    const uci = pv[ply]
    let move
    try { move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }) } catch { return false }
    if (move.promotion) return false
    if (ply === 0) {
      movedPiece = move.piece
      if (movedPiece === 'p' || movedPiece === 'k') return false
    } else if (capturedAt < 0 && move.color !== side && move.captured && move.to === movedSquare && move.captured === movedPiece) {
      if (baseline - material(chess, side) < 2) return false
      capturedAt = ply
    } else if (capturedAt < 0 && move.color === side && move.from === movedSquare) {
      movedSquare = move.to
    }
    if (capturedAt >= 0 && ply === capturedAt + 1) {
      qualifyingReply = move.color === side && (baseline - material(chess, side) >= 2 || (chess.isCheckmate() && chess.turn() !== side))
    }
  }
  return qualifyingReply
}

export function pvSan(position: PositionSpec, pv: string[]): string[] {
  const chess = new Chess(position.initialFen)
  for (const uci of position.moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
  const san: string[] = []
  for (const uci of pv) {
    try { san.push(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san) } catch { break }
  }
  return san
}

export function classifyMove(input: {
  game: GameDocument; nodeId: string; bestSnapshots: DepthSnapshot[]; playedSnapshots?: DepthSnapshot[]
  forced?: boolean; terminal?: 'checkmate' | 'stalemate' | 'draw'
}): ReviewMove {
  const { game, nodeId, bestSnapshots, playedSnapshots, forced, terminal } = input
  const node = game.nodes[nodeId]
  if (!node?.parentId || !node.uci || !node.san) throw new Error('Review requires a legal mainline move')
  const pre = reconstruct(game, node.parentId)
  const side = pre.turn() === 'w' ? 'white' : 'black'
  const post = reconstruct(game, nodeId)
  const outcome = terminal ?? terminalAssessment(post)
  const postScore: EngineScore | undefined = outcome === 'checkmate' ? { kind: 'mate', value: 1 } : outcome ? { kind: 'cp', value: 0 } : undefined
  const result: ReviewMove = { nodeId, san: node.san, side, label: 'Uncertain', actualDepth: 0, explanation: 'Exact completed scores are unavailable.', terminal: outcome,
    whiteScore: postScore && toWhiteScore(postScore, side) }
  if (forced) return { ...result, label: 'Forced', explanation: outcome ? `Only one legal move; ${outcome} by chess rules.` : 'Only one legal move.' }
  const positions = getPosition(game, node.parentId)
  const exact = (snapshot: DepthSnapshot) => snapshot.candidates.length > 0 && snapshot.candidates.every(candidate =>
    !candidate.score.bound && candidate.pv.length > 0 && candidate.pv[0] === candidate.move && pvSan(positions, candidate.pv).length === candidate.pv.length)
  const bestByDepth = new Map(bestSnapshots.filter(exact).map(s => [s.depth, s]))
  const playedByDepth = new Map((playedSnapshots ?? []).filter(exact).map(s => [s.depth, s]))
  result.bestDepth = Math.max(0, ...bestSnapshots.map(snapshot => snapshot.depth))
  result.playedDepth = Math.max(0, ...(playedSnapshots ?? []).map(snapshot => snapshot.depth))
  const common = [...bestByDepth.keys()].filter(depth => {
    const snapshot = bestByDepth.get(depth)!
    return !!postScore || snapshot.candidates.some(c => c.move === node.uci) || playedByDepth.has(depth)
  }).sort((a, b) => b - a)[0]
  if (common === undefined) {
    result.explanation = `No common completed exact depth (best ${result.bestDepth}, played ${result.playedDepth}).`
    return result
  }
  const snapshot = bestByDepth.get(common)!
  const best = snapshot.candidates[0]
  const played = postScore ? { move: node.uci, score: postScore, pv: [node.uci] }
    : snapshot.candidates.find(c => c.move === node.uci) ?? playedByDepth.get(common)?.candidates[0]
  result.actualDepth = common
  if (postScore || snapshot.candidates.some(candidate => candidate.move === node.uci)) result.playedDepth = common
  result.best = best
  result.played = played
  result.runnerUp = snapshot.candidates[1]
  result.bestSan = pvSan(positions, best.pv)
  if (!best || !played || played.move !== node.uci) return result
  const loss = moverLoss(best.score, played.score)
  if (loss === undefined) return result
  result.whiteScore = toWhiteScore(played.score, side)
  if (common < 10) {
    result.explanation = `Depth ${common} is below the minimum reliable review depth 10.`
    return result
  }
  result.lossCp = loss
  const top = best.move === node.uci
  const safe = played.score.kind === 'mate' ? played.score.value > 0 : played.score.value >= -50
  const sacrifice = top && loss <= 10 && common >= 14 && safe && isEngineBackedSacrifice(positions, node.uci, best.pv)
  const runnerLoss = result.runnerUp ? moverLoss(best.score, result.runnerUp.score) : undefined
  if (sacrifice) result.label = 'Brilliant'
  else if (top && loss <= 10 && common >= 14 && runnerLoss !== undefined && runnerLoss >= 150) result.label = 'Great'
  else if (top || loss <= 10) result.label = 'Best'
  else if (loss <= 25) result.label = 'Excellent'
  else if (loss <= 75) result.label = 'Good'
  else if (loss <= 150) result.label = 'Inaccuracy'
  else if (loss <= 300) result.label = 'Mistake'
  else result.label = 'Blunder'
  const versus = result.bestSan[0] && !top ? ` versus ${result.bestSan[0]}` : ''
  const mateTransition = loss === 1000 && (best.score.kind === 'mate' || played.score.kind === 'mate')
  result.explanation = sacrifice ? 'Preserves the engine’s best continuation with an engine-backed sacrifice heuristic.'
    : mateTransition ? `${best.score.kind === 'mate' && best.score.value > 0 ? 'Lost a forced mate' : 'Allowed a forced mate'}${versus}.`
    : outcome === 'checkmate' ? 'Checkmate; the position is decided by chess rules.'
    : outcome ? `${outcome === 'stalemate' ? 'Stalemate' : 'Draw'} by chess rules; ${loss ? `lost ${(loss / 100).toFixed(1)} pawns${versus}` : 'no measurable loss'}.`
    : loss ? `Lost ${(loss / 100).toFixed(1)} pawns${versus}.`
    : result.label === 'Great' ? `Best move; runner-up ${result.runnerUp?.score.kind === 'mate' || best.score.kind === 'mate' ? 'loses a forced mate' : `loses at least ${(runnerLoss! / 100).toFixed(1)} pawns`}.`
    : top ? 'Matches the engine’s best completed continuation.' : 'No measurable loss at the completed depth.'
  return result
}

export function reviewSummary(report: ReviewReport, game: GameDocument) {
  const mainline = mainlineNodes(game)
  const bySide = { white: { total: 0, graded: 0, quality: null as number | null, counts: {} as Record<string, number> }, black: { total: 0, graded: 0, quality: null as number | null, counts: {} as Record<string, number> } }
  const sums = { white: 0, black: 0 }
  for (const id of mainline) {
    const node = game.nodes[id]
    const side = game.nodes[node.parentId!].fen.split(' ')[1] === 'w' ? 'white' : 'black'
    const summary = bySide[side]
    const move = report.moves[id]
    if (move?.label === 'Forced') { summary.counts.Forced = (summary.counts.Forced ?? 0) + 1; continue }
    summary.total++
    if (move) summary.counts[move.label] = (summary.counts[move.label] ?? 0) + 1
    if (move?.lossCp === undefined) continue
    summary.graded++
    sums[side] += 100 * Math.exp(-Math.min(move.lossCp, 1000) / 200)
  }
  for (const side of ['white', 'black'] as const) if (bySide[side].graded) bySide[side].quality = Math.round(sums[side] / bySide[side].graded)
  return bySide
}
