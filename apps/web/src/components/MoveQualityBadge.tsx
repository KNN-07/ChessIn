import type { CSSProperties, ReactNode } from 'react'
import type { ReviewLabel } from '@chessin/core/review'
import './move-quality.css'

const glyphs: Record<ReviewLabel, ReactNode> = {
  Brilliant: <path d="M5 3h5l-.7 12H5.7L5 3Zm.5 14h4v4h-4v-4ZM14 3h5l-.7 12h-3.6L14 3Zm.5 14h4v4h-4v-4Z" />,
  Great: <path d="M9.5 3h5l-.7 12h-3.6L9.5 3Zm.5 14h4v4h-4v-4Z" />,
  Best: <path d="m12 2.5 3 6.1 6.7 1-4.8 4.7 1.1 6.7-6-3.2L6 21l1.1-6.7-4.8-4.7 6.7-1L12 2.5Z" />,
  Excellent: <path d="M3 10h4v11H3V10Zm6 0 3-7c.3-.8 1.5-1 2.1-.3.9 1.1.8 2.9.3 4.3l-.4 1h5c1.4 0 2.4 1.3 2.1 2.7l-1.7 8c-.2 1.1-1.2 1.8-2.3 1.8H9V10Z" />,
  Good: <path d="m4 12 5 5L20 6" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />,
  Inaccuracy: <><path d="M3 7a4 4 0 0 1 8 0c0 3-4 3-4 6v1M17 4v10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /><circle cx="7" cy="19" r="1.8" /><circle cx="17" cy="19" r="1.8" /></>,
  Mistake: <><path d="M7 7a5 5 0 0 1 10 0c0 3.5-5 3.5-5 7" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" /><circle cx="12" cy="19.5" r="2" /></>,
  Blunder: <><path d="M2.5 7a4 4 0 0 1 8 0c0 3-4 3-4 7m7-7a4 4 0 0 1 8 0c0 3-4 3-4 7" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" /><circle cx="6.5" cy="19" r="1.8" /><circle cx="17.5" cy="19" r="1.8" /></>,
  Forced: <path d="M6 4v9h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />,
  Uncertain: <><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></>,
}

export function MoveQualityBadge({ label, className = '', style, decorative = false }: {
  label: ReviewLabel
  className?: string
  style?: CSSProperties
  decorative?: boolean
}) {
  return <span className={`move-quality-mark quality-${label.toLowerCase()} ${className}`} style={style} title={label} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}>
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">{glyphs[label]}</svg>
  </span>
}
