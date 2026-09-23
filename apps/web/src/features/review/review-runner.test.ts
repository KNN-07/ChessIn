import { describe, expect, it } from 'vitest'
import { appendMove, createGame } from '@chessin/core/game'
import type { AnalysisRequest, EngineEvent } from '@chessin/core/engine'
import { classifyMove, mainlineNodes, reviewSignature, type ReviewReport } from '@chessin/core/review'
import { prepareReview, runReview, type ReviewSearch } from './review-runner'

function info(requestId: string, depth: number, multiPv: number, value: number, move: string): EngineEvent {
  return { type: 'info', requestId, depth, multiPv, score: { kind: 'cp', value }, pv: [move] }
}

describe('sequential review searches', () => {
  it('retains complete depths, restricts an absent played move, and ignores unfinished higher iterations', async () => {
    const game = appendMove(createGame(), 'e4')
    const descriptor = { id: 'stockfish', name: 'Stockfish 19', buildVersion: '19' }
    const signature = reviewSignature(game, descriptor, 'local', { strength: { kind: 'full' }, multiPv: 2 }, 16, 3000)
    const requests: AnalysisRequest[] = []
    const search: ReviewSearch = async function* (request) {
      requests.push(request)
      const id = request.requestId
      yield { type: 'started', requestId: id }
      if (!request.searchMoves) {
        yield info(id, 12, 1, 250, 'd2d4')
        yield info(id, 12, 2, 100, 'g1f3')
        yield info(id, 14, 1, 250, 'd2d4')
        yield info(id, 14, 2, 120, 'g1f3')
        yield info(id, 15, 1, 300, 'd2d4')
      } else {
        yield info(id, 12, 1, 30, 'e2e4')
        yield info(id, 14, 1, -200, 'e2e4')
      }
      yield { type: 'bestmove', requestId: id, move: request.searchMoves?.[0] ?? 'd2d4' }
      yield { type: 'done', requestId: id, reason: 'completed' }
    }
    const progress: ReviewReport[] = []
    const result = await runReview(game, prepareReview(game, signature), search, new AbortController().signal, state => { progress.push(state) })
    expect(requests).toHaveLength(2)
    expect(requests[0].settings.strength).toEqual({ kind: 'full' })
    expect(requests[0].settings.multiPv).toBe(2)
    expect(requests[1].searchMoves).toEqual(['e2e4'])
    expect(requests[1].position.moves).toEqual([])
    expect(result.moves[game.currentId].actualDepth).toBe(14)
    expect(result.moves[game.currentId].label).toBe('Blunder')
    expect(result.moves[game.currentId].lossCp).toBe(450)
    expect(result.status).toBe('completed')
    expect(progress).toHaveLength(2)
  })

  it('avoids a restricted search when the played move immediately ends the game', async () => {
    let game = createGame()
    for (const move of ['f3', 'e5', 'g4', 'Qh4#']) game = appendMove(game, move)
    const terminalId = game.currentId
    const signature = reviewSignature(game, { id: 'sf', name: 'Stockfish', buildVersion: '19' }, 'local', { strength: { kind: 'full' }, multiPv: 2 }, 16, 3000)
    const prior = prepareReview(game, signature)
    for (const id of mainlineNodes(game).slice(0, -1)) prior.moves[id] = classifyMove({ game, nodeId: id, bestSnapshots: [] })
    const positions: string[][] = []
    const search: ReviewSearch = async function* (request) {
      positions.push(request.position.moves)
      const id = request.requestId
      yield info(id, 16, 1, 300, 'd8h4')
      yield info(id, 16, 2, 100, 'b8c6')
      yield { type: 'bestmove', requestId: id, move: 'd8h4' }
      yield { type: 'done', requestId: id, reason: 'completed' }
    }
    const result = await runReview(game, prior, search, new AbortController().signal, () => {})
    expect(result.moves[terminalId].terminal).toBe('checkmate')
    expect(result.moves[terminalId].whiteScore).toMatchObject({ kind: 'mate', value: -1 })
    expect(positions).toContainEqual(['f2f3', 'e7e5', 'g2g4'])
    expect(positions).toHaveLength(1)
  })
})
