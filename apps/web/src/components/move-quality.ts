import type { ReviewLabel } from '@chessin/core/review'

export const moveSymbols: Record<ReviewLabel, string> = {
  Brilliant: '!!', Great: '!', Best: '✓', Excellent: '✓', Good: '·',
  Inaccuracy: '?!', Mistake: '?', Blunder: '??', Forced: '↳', Uncertain: '…',
}
