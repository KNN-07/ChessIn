import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Chessboard } from 'react-chessboard'
import type { Square } from 'chess.js'
import { reconstruct, type GameDocument } from '@chessin/core/game'
import { useDialogFocus } from './useDialogFocus'

type Arrow = { startSquare: string; endSquare: string; color: string }
export interface AnalysisBoardProps {
  game: GameDocument
  onMove: (uci: string) => void
  orientation?: 'white' | 'black'
  disabled?: boolean
  arrows?: Arrow[]
}

export function AnalysisBoard({ game, onMove, orientation = 'white', disabled = false, arrows = [] }: AnalysisBoardProps) {
  const chess = useMemo(() => reconstruct(game), [game])
  const [selected, setSelected] = useState<Square | null>(null)
  const [promotion, setPromotion] = useState<{ from: Square; to: Square } | null>(null)
  useDialogFocus('.promotion-shade', !!promotion, () => setPromotion(null))
  useEffect(() => { setSelected(null); setPromotion(null) }, [game.currentId, game.id])
  const legal = selected ? chess.moves({ square: selected, verbose: true }) : []
  const lastUci = game.nodes[game.currentId]?.uci
  const styles: Record<string, CSSProperties> = {}
  if (lastUci) {
    styles[lastUci.slice(0, 2)] = { backgroundColor: '#d2ca685c' }
    styles[lastUci.slice(2, 4)] = { backgroundColor: '#d2ca6880' }
  }
  if (chess.isCheck()) {
    const king = chess.findPiece({ type: 'k', color: chess.turn() })[0]
    if (king) styles[king] = { background: 'radial-gradient(ellipse, #e95658b8 5%, #e9565822 70%)' }
  }
  if (selected) {
    styles[selected] = { backgroundColor: '#e9e88699' }
    for (const move of legal) styles[move.to] = move.captured
      ? { background: 'radial-gradient(transparent 56%, #263b2573 57%)' }
      : { background: 'radial-gradient(#263b2573 18%, transparent 20%)' }
  }

  function attempt(from: Square, to: Square): boolean {
    if (disabled || promotion) return false
    const moves = chess.moves({ square: from, verbose: true }).filter(move => move.to === to)
    if (!moves.length) return false
    if (moves.some(move => move.promotion)) {
      setPromotion({ from, to })
      setSelected(null)
      return false
    }
    onMove(`${from}${to}`)
    setSelected(null)
    return true
  }

  return <div className="board-frame">
    <Chessboard options={{
      id: 'analysis-board', position: chess.fen(), boardOrientation: orientation,
      lightSquareStyle: { backgroundColor: '#eeeed2' }, darkSquareStyle: { backgroundColor: '#769656' },
      boardStyle: { borderRadius: '4px', overflow: 'hidden' },
      allowDragging: !disabled && !promotion, allowDragOffBoard: false,
      allowDrawingArrows: false, arrows, squareStyles: styles,
      onPieceDrag: ({ square }) => { if (!disabled && square && chess.get(square as Square)?.color === chess.turn()) setSelected(square as Square) },
      onPieceDragCancel: () => setSelected(null),
      onPieceDrop: ({ sourceSquare, targetSquare }) => targetSquare ? attempt(sourceSquare as Square, targetSquare as Square) : false,
      onSquareClick: ({ square }) => {
        if (disabled || promotion) return
        const clicked = square as Square
        if (selected && attempt(selected, clicked)) return
        setSelected(chess.get(clicked)?.color === chess.turn() ? clicked : null)
      },
    }} />
    {promotion && <div className="promotion-shade" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
      <div className="promotion-card">
        <strong>Promote pawn to</strong>
        <div className="promotion-choices">{(['q', 'r', 'b', 'n'] as const).map(piece => <button key={piece} type="button" onClick={() => {
          onMove(`${promotion.from}${promotion.to}${piece}`)
          setPromotion(null)
        }} aria-label={`Promote to ${{ q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }[piece]}`}>
          { { q: '♛', r: '♜', b: '♝', n: '♞' }[piece] }<span>{ { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[piece] }</span>
        </button>)}</div>
        <button className="subtle-button" type="button" onClick={() => setPromotion(null)}>Cancel</button>
      </div>
    </div>}
  </div>
}
