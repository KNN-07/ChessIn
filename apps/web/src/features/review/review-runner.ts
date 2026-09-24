import { getPosition, reconstruct, type GameDocument } from '@chessin/core/game'
import type { AnalysisRequest, EngineEvent, EngineScore } from '@chessin/core/engine'
import {
  classifyMove, mainlineNodes, matchesReview, reviewSignature, terminalAssessment,
  type Candidate, type DepthSnapshot, type ReviewReport, type ReviewSignature,
} from '@chessin/core/review'

export type ReviewSearch = (request: AnalysisRequest, signal: AbortSignal) => AsyncIterable<EngineEvent>
export type ReviewProgress = (report: ReviewReport) => void | Promise<void>

export class ReviewInterrupted extends Error {
  constructor(message = 'Review interrupted. Resume to continue.') { super(message) }
}

function snapshotsFor(request: AnalysisRequest, expectedPv: number, search: ReviewSearch, signal: AbortSignal): Promise<DepthSnapshot[]> {
  return (async () => {
    const pending = new Map<number, Map<number, Candidate>>()
    const completed = new Map<number, DepthSnapshot>()
    let ended = false
    let bestmove = false
    for await (const event of search(request, signal)) {
      if (signal.aborted) throw new ReviewInterrupted()
      if (event.requestId !== request.requestId) continue
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'info') {
        if (bestmove || ended || event.depth <= 0 || event.multiPv < 1 || event.multiPv > expectedPv || !event.score || !event.pv.length) continue
        const candidate = { move: event.pv[0], score: { ...event.score } as EngineScore, pv: [...event.pv] }
        let atDepth = pending.get(event.depth)
        if (!atDepth) { atDepth = new Map(); pending.set(event.depth, atDepth) }
        atDepth.set(event.multiPv, candidate)
        if (atDepth.size === expectedPv && Array.from({ length: expectedPv }, (_, i) => atDepth!.has(i + 1)).every(Boolean)) {
          const candidates = Array.from({ length: expectedPv }, (_, i) => atDepth!.get(i + 1)!)
          // Aspiration-window bounds must not replace an already completed exact iteration.
          if (candidates.every(candidate => !candidate.score.bound)) completed.set(event.depth, { depth: event.depth, candidates })
        }
      }
      if (event.type === 'bestmove') bestmove = true
      if (event.type === 'done') {
        if (event.reason === 'cancelled') throw new ReviewInterrupted()
        ended = true
      }
    }
    if (signal.aborted) throw new ReviewInterrupted()
    if (!ended || !bestmove) throw new ReviewInterrupted('Engine stopped before completing its search.')
    return [...completed.values()].sort((a, b) => a.depth - b.depth)
  })()
}

export function prepareReview(game: GameDocument, signature: ReviewSignature, prior?: ReviewReport): ReviewReport {
  if (prior && matchesReview(prior, signature) && prior.status !== 'cancelled') return { ...prior, moves: { ...prior.moves }, status: 'paused' }
  return { signature, moves: {}, status: 'paused' }
}

/** Searches are sequential. Progress is emitted only after a fully classified move. */
export async function runReview(game: GameDocument, report: ReviewReport, search: ReviewSearch, signal: AbortSignal, onProgress: ReviewProgress): Promise<ReviewReport> {
  const signature = report.signature
  const ids = mainlineNodes(game)
  if (signature.gameId !== game.id || signature.treeVersion !== JSON.stringify([game.rootFen, game.rootId, game.nodes]) || JSON.stringify(signature.mainline) !== JSON.stringify(ids.map(id => game.nodes[id].uci))) {
    throw new Error('The game changed; start a new review.')
  }
  let current = { ...report, moves: { ...report.moves }, status: 'paused' as const }
  for (const id of ids) {
    if (signal.aborted) throw new ReviewInterrupted()
    if (current.moves[id]) continue
    const node = game.nodes[id]
    const before = reconstruct(game, node.parentId!)
    const priorTerminal = terminalAssessment(before)
    if (priorTerminal) {
      const ungraded = classifyMove({ game, nodeId: id, bestSnapshots: [], terminal: priorTerminal })
      current = { ...current, moves: { ...current.moves, [id]: { ...ungraded, explanation: `Game already ${priorTerminal === 'checkmate' ? 'ended in checkmate' : priorTerminal === 'stalemate' ? 'ended in stalemate' : 'drawn'} before this move; no engine search.` } } }
      await onProgress(current)
      continue
    }
    const legalMoves = before.moves()
    const after = reconstruct(game, id)
    const terminal = terminalAssessment(after)
    if (legalMoves.length === 1) {
      current = { ...current, moves: { ...current.moves, [id]: classifyMove({ game, nodeId: id, bestSnapshots: [], forced: true, terminal }) } }
      await onProgress(current)
      continue
    }
    const position = getPosition(game, node.parentId!)
    const limit = { kind: 'bounded' as const, depth: signature.depth, moveTimeMs: signature.moveTimeMs }
    const settings = { ...signature.settings, strength: { kind: 'full' as const } }
    const requestedPv = Math.min(signature.settings.multiPv ?? 1, legalMoves.length)
    const bestRequest: AnalysisRequest = { requestId: crypto.randomUUID(), engineId: signature.engineId, position, settings: { ...settings, ...(signature.settings.multiPv === undefined ? {} : { multiPv: requestedPv }) }, limit }
    const best = await snapshotsFor(bestRequest, requestedPv, search, signal)
    let assessment = classifyMove({ game, nodeId: id, bestSnapshots: best, terminal })
    // An appearance in an early iteration is not evidence for the deeper best-move score.
    if (!terminal && (!assessment.played || assessment.actualDepth < (assessment.bestDepth ?? 0))) {
      const playedRequest: AnalysisRequest = {
        ...bestRequest, requestId: crypto.randomUUID(), settings: { ...settings, ...(signature.settings.multiPv === undefined ? {} : { multiPv: 1 }) }, searchMoves: [node.uci!],
      }
      const played = await snapshotsFor(playedRequest, 1, search, signal)
      assessment = classifyMove({ game, nodeId: id, bestSnapshots: best, playedSnapshots: played, terminal })
    }
    if (signal.aborted) throw new ReviewInterrupted()
    current = { ...current, moves: { ...current.moves, [id]: assessment } }
    await onProgress(current)
  }
  const completed: ReviewReport = { ...current, status: 'completed' }
  await onProgress(completed)
  return completed
}

export { reviewSignature }
