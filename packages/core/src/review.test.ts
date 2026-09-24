import { describe, expect, it } from 'vitest'
import { appendMove, createGame, getPosition, selectNode } from './game.js'
import { classifyMove, isEngineBackedSacrifice, matchesReview, moverLoss, reviewSignature, reviewSummary, toWhiteScore, type DepthSnapshot, type ReviewReport } from './review.js'

const sacrificeFen = '5r1k/6pp/7N/8/8/1Q6/8/6K1 w - - 0 1'
const sacrificePv = ['b3g8', 'f8g8', 'h6f7']
const greekGiftFen = 'rnbq1rk1/ppp2ppp/3bpn2/3pP3/3P4/3B1N2/PPP2PPP/RNBQ1RK1 w - - 0 1'
const greekGiftPv = ['d3h7', 'g8h7', 'f3g5']

function candidate(move: string, value: number, depth: number, pv = [move]): DepthSnapshot {
  return { depth, candidates: [{ move, score: { kind: 'cp', value }, pv }] }
}

describe('review classification', () => {
  it('awards a depth-14 legal queen sacrifice and refuses the identical depth-9 evidence', () => {
    const game = appendMove(createGame(sacrificeFen), 'b3g8')
    const position = getPosition(game, game.rootId)
    expect(isEngineBackedSacrifice(position, 'b3g8', sacrificePv)).toBe(true)
    expect(isEngineBackedSacrifice(position, 'b3g8', ['b3g8', 'f8g8'])).toBe(false)
    expect(isEngineBackedSacrifice(position, 'b3g8', ['b3g8', 'f8g8', 'h6h5'])).toBe(false)
    expect(isEngineBackedSacrifice(position, 'b3g8', [...sacrificePv, 'g8f8'])).toBe(false)
    const snapshot = (depth: number): DepthSnapshot => ({ depth, candidates: [
      { move: 'b3g8', score: { kind: 'mate', value: 2 }, pv: sacrificePv },
      { move: 'h6f7', score: { kind: 'cp', value: -300 }, pv: ['h6f7'] },
    ] })
    const brilliant = classifyMove({ game, nodeId: game.currentId, bestSnapshots: [snapshot(14)] })
    expect(brilliant.label).toBe('Brilliant')
    expect(brilliant.bestSan).toEqual(['Qg8+', 'Rxg8', 'Nf7#'])
    const shallow = classifyMove({ game, nodeId: game.currentId, bestSnapshots: [snapshot(9)] })
    expect(shallow.label).toBe('Uncertain')
    expect(shallow.lossCp).toBeUndefined()
  })

  it.each([
    { depth: 11, loss: 0, score: 0, top: true, label: 'Best' },
    { depth: 12, loss: 0, score: 0, top: true, label: 'Brilliant' },
    { depth: 12, loss: 50, score: 0, top: false, label: 'Brilliant' },
    { depth: 12, loss: 51, score: 0, top: false, label: 'Good' },
    { depth: 12, loss: 50, score: -50, top: false, label: 'Brilliant' },
    { depth: 12, loss: 50, score: -51, top: false, label: 'Good' },
  ])('grades a sacrifice at depth $depth, loss $loss, score $score, top $top as $label', ({ depth, loss, score, top, label }) => {
    const game = appendMove(createGame(greekGiftFen), 'd3h7')
    const played = candidate('d3h7', score, depth, greekGiftPv)
    const result = classifyMove({ game, nodeId: game.currentId,
      bestSnapshots: [top ? played : candidate('f3g5', score + loss, depth)],
      playedSnapshots: [played],
    })
    expect(result.label).toBe(label)
    expect(result.lossCp).toBe(loss)
  })

  it.each([
    { pv: ['d3h7', 'g8h7'], label: 'Good' },
    { pv: ['d3h7', 'g8h7', 'f3f5'], label: 'Uncertain' },
    { pv: [], label: 'Uncertain' },
  ])('requires a legal sacrifice follow-up in the played continuation: $pv', ({ pv, label }) => {
    const game = appendMove(createGame(greekGiftFen), 'd3h7')
    expect(classifyMove({ game, nodeId: game.currentId,
      bestSnapshots: [candidate('f3g5', 50, 12)],
      playedSnapshots: [candidate('d3h7', 0, 12, pv)],
    }).label).toBe(label)
  })

  it('does not transfer a best-move sacrifice to a different near-best move', () => {
    const game = appendMove(createGame(greekGiftFen), 'f3g5')
    expect(classifyMove({ game, nodeId: game.currentId,
      bestSnapshots: [candidate('d3h7', 50, 12, greekGiftPv)],
      playedSnapshots: [candidate('f3g5', 0, 12)],
    }).label).toBe('Good')
  })

  it('assigns mover-relative 400cp loss to both colors and flips display scores only once', () => {
    let game = appendMove(createGame(), 'e4')
    const white = game.currentId
    game = appendMove(game, 'e5')
    const black = game.currentId
    const grade = (nodeId: string, best: string, played: string) => classifyMove({ game, nodeId,
      bestSnapshots: [{ depth: 16, candidates: [{ move: best, score: { kind: 'cp', value: 200 }, pv: [best] }] }],
      playedSnapshots: [candidate(played, -200, 16)],
    })
    const whiteGrade = grade(white, 'd2d4', 'e2e4')
    const blackGrade = grade(black, 'c7c5', 'e7e5')
    expect([whiteGrade.label, blackGrade.label]).toEqual(['Blunder', 'Blunder'])
    expect([whiteGrade.lossCp, blackGrade.lossCp]).toEqual([400, 400])
    expect(whiteGrade.whiteScore?.value).toBe(-200)
    expect(blackGrade.whiteScore?.value).toBe(200)
    expect(toWhiteScore({ kind: 'cp', value: 20, bound: 'lower' }, 'black')).toEqual({ kind: 'cp', value: -20, bound: 'upper' })
    const report = { moves: { [white]: whiteGrade, [black]: blackGrade } } as ReviewReport
    const summary = reviewSummary(report, game)
    expect(summary.white.quality).toBe(14)
    expect(summary.black.quality).toBe(14)
    expect(summary.white.graded).toBe(1)
  })

  it('never compares bounds or unequal completed depths and keeps forced moves ungraded', () => {
    const game = appendMove(createGame(), 'e4')
    const bound: DepthSnapshot = { depth: 16, candidates: [{ move: 'd2d4', score: { kind: 'cp', value: 200, bound: 'lower' }, pv: ['d2d4'] }] }
    const bounded = classifyMove({ game, nodeId: game.currentId, bestSnapshots: [bound], playedSnapshots: [candidate('e2e4', -300, 16)] })
    expect(bounded.label).toBe('Uncertain')
    expect(bounded.bestDepth).toBe(16)
    const unequal = classifyMove({ game, nodeId: game.currentId, bestSnapshots: [candidate('d2d4', 200, 16)], playedSnapshots: [candidate('e2e4', -300, 14)] })
    expect(unequal.label).toBe('Uncertain')
    const forced = classifyMove({ game, nodeId: game.currentId, bestSnapshots: [], forced: true })
    expect(forced.label).toBe('Forced')
    expect(forced.lossCp).toBeUndefined()
    expect(classifyMove({ game, nodeId: game.currentId, bestSnapshots: [candidate('e2e4', 250, 16)] }).label).toBe('Best')
  })

  it('retains captured revision as provenance while selection-only changes keep review usable', () => {
    const game = appendMove(createGame(), 'e4')
    const descriptor = { id: 'stockfish', name: 'Stockfish 19', buildVersion: '19' }
    const settings = { strength: { kind: 'full' as const }, multiPv: 2 }
    const original = reviewSignature(game, descriptor, 'local', settings, 16, 3000)
    const report: ReviewReport = { signature: original, moves: {}, status: 'paused' }
    const navigated = selectNode(game, game.rootId)
    expect(navigated.revision).not.toBe(game.revision)
    expect(matchesReview(report, reviewSignature(navigated, descriptor, 'local', settings, 16, 3000))).toBe(true)
    expect(matchesReview(report, reviewSignature(appendMove(navigated, 'd4', game.rootId), descriptor, 'local', settings, 16, 3000))).toBe(false)
    expect(matchesReview(report, reviewSignature(game, descriptor, 'local', settings, 18, 3000))).toBe(false)
    const oldReport: ReviewReport = JSON.parse(JSON.stringify(report))
    Object.assign(oldReport.signature, { algorithmVersion: 'chessin-review-v1' })
    expect(matchesReview(oldReport, original)).toBe(false)
  })

  it('honors mate transitions rather than fabricating centipawn conversions', () => {
    expect(moverLoss({ kind: 'mate', value: 2 }, { kind: 'mate', value: 8 })).toBe(0)
    expect(moverLoss({ kind: 'mate', value: -3 }, { kind: 'mate', value: -1 })).toBe(0)
    expect(moverLoss({ kind: 'mate', value: 2 }, { kind: 'cp', value: 500 })).toBe(1000)
    expect(moverLoss({ kind: 'cp', value: -900 }, { kind: 'mate', value: -2 })).toBe(1000)
    expect(moverLoss({ kind: 'cp', value: 100 }, { kind: 'mate', value: 4 })).toBe(0)
    expect(moverLoss({ kind: 'cp', value: 100, bound: 'upper' }, { kind: 'cp', value: 50 })).toBeUndefined()
  })
})
