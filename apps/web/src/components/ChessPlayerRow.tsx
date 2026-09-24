import type { ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChessPawn } from '@fortawesome/free-solid-svg-icons'
import '../styles/chess-workspace.css'

interface ChessPlayerRowProps {
  name: string
  side: 'white' | 'black'
  rating?: string
  detail?: ReactNode
  clock?: string
  active?: boolean
}

export function ChessPlayerRow({ name, side, rating, detail, clock, active = false }: ChessPlayerRowProps) {
  return <div className="chess-player-row">
    <span className={`chess-player-avatar ${side}`} aria-hidden="true"><FontAwesomeIcon icon={faChessPawn} /></span>
    <div className="chess-player-copy"><strong title={name}>{name}{rating && <span className="chess-player-rating"> ({rating})</span>}</strong><span className="chess-player-detail">{detail || (side === 'white' ? 'White' : 'Black')}</span></div>
    <span className={`chess-clock ${side} ${active ? 'is-active' : ''}`} aria-label={`${side === 'white' ? 'White' : 'Black'} clock`}>{clock ?? (active ? 'To move' : '—')}</span>
  </div>
}
