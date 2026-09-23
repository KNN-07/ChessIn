import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { appendMove, deleteVariation, exportFen, getPosition, promoteVariation, reconstruct, selectNode, type GameDocument, type GameNode, type PositionSpec } from '@chessin/core/game'
import type { EngineEvent, EngineScore } from '@chessin/core/engine'
import { Chess } from 'chess.js'
import { AnalysisBoard } from '../../components/AnalysisBoard'
import { useEngine } from '../../engine/EngineContext'
import { EngineSettingsPanel } from '../../engine/EngineSettingsPanel'

export interface AnalysisPageProps {
  game: GameDocument
  onChange: (game: GameDocument) => void
  reviewPanel?: ReactNode
  grades?: Record<string, { label: string }>
  initialPane?: 'moves' | 'engine' | 'review'
}

const pieces: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 }

function whiteScore(score: EngineScore | undefined, turn: 'w' | 'b'): EngineScore | undefined {
  if (!score || turn === 'w') return score
  return { ...score, value: -score.value, bound: score.bound === 'lower' ? 'upper' : score.bound === 'upper' ? 'lower' : undefined }
}
function scoreLabel(score?: EngineScore): string {
  if (!score) return '—'
  const bound = score.bound === 'lower' ? '≥' : score.bound === 'upper' ? '≤' : ''
  if (score.kind === 'mate') return `${bound}${score.value < 0 ? '−' : ''}M${Math.abs(score.value)}`
  return `${bound}${score.value < 0 ? '−' : '+'}${(Math.abs(score.value) / 100).toFixed(2)}`
}
function pvSan(position: PositionSpec, pv: string[]): string {
  try {
    const chess = new Chess(position.initialFen)
    for (const uci of position.moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
    return pv.map(uci => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san).join(' ')
  } catch { return '' }
}
function statusOf(chess: Chess): string {
  if (chess.isCheckmate()) return `Checkmate · ${chess.turn() === 'w' ? 'Black' : 'White'} wins`
  if (chess.isStalemate()) return 'Draw · stalemate'
  if (chess.isThreefoldRepetition()) return 'Draw · threefold repetition'
  if (chess.isInsufficientMaterial()) return 'Draw · insufficient material'
  if (chess.isDraw()) return 'Draw · 50-move rule'
  return `${chess.turn() === 'w' ? 'White' : 'Black'} to move${chess.isCheck() ? ' · check' : ''}`
}
function captured(chess: Chess, rootFen: string): { white: string; black: string; advantage: number } {
  const counts: Record<string, number> = { wp: 0, wn: 0, wb: 0, wr: 0, wq: 0, bp: 0, bn: 0, bb: 0, br: 0, bq: 0 }
  for (const row of new Chess(rootFen).board()) for (const piece of row) if (piece && piece.type !== 'k') counts[`${piece.color}${piece.type}`]++
  for (const row of chess.board()) for (const piece of row) if (piece && piece.type !== 'k') counts[`${piece.color}${piece.type}`]--
  const glyphs: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' }
  const white = Object.entries(glyphs).map(([piece, glyph]) => glyph.repeat(Math.max(0, counts[`b${piece}`]))).join('')
  const black = Object.entries(glyphs).map(([piece, glyph]) => glyph.repeat(Math.max(0, counts[`w${piece}`]))).join('')
  const value = (side: 'w' | 'b') => Object.entries(pieces).reduce((sum, [piece, weight]) => sum + counts[`${side}${piece}`] * weight, 0)
  return { white, black, advantage: value('b') - value('w') }
}

export function AnalysisPage({ game, onChange, reviewPanel, grades, initialPane = 'moves' }: AnalysisPageProps) {
  const chess = useMemo(() => reconstruct(game), [game])
  const position = useMemo(() => getPosition(game), [game])
  const engine = useEngine()
  const [orientation, setOrientation] = useState<'white' | 'black'>('white')
  const [pane, setPane] = useState<'moves' | 'engine' | 'review'>(initialPane)
  const [moveText, setMoveText] = useState('')
  const [message, setMessage] = useState('')
  const [running, setRunning] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [lines, setLines] = useState<Record<number, Extract<EngineEvent, { type: 'info' }>>>({})
  const [engineMessage, setEngineMessage] = useState('Start analysis to see engine lines.')
  const active = useRef(false)
  const searchToken = useRef(0)
  const current = game.nodes[game.currentId]
  const material = useMemo(() => captured(chess, game.rootFen), [chess, game.rootFen])
  const topName = orientation === 'white' ? game.headers.Black || 'Black pieces' : game.headers.White || 'White pieces'
  const bottomName = orientation === 'white' ? game.headers.White || 'White pieces' : game.headers.Black || 'Black pieces'
  const topCaptures = orientation === 'white' ? material.black : material.white
  const bottomCaptures = orientation === 'white' ? material.white : material.black
  const topAdvantage = orientation === 'white' ? -material.advantage : material.advantage
  const bottomAdvantage = -topAdvantage
  const leader = lines[1]
  const terminalScore: EngineScore | undefined = chess.isCheckmate() ? { kind: 'mate', value: 0 } : chess.isDraw() ? { kind: 'cp', value: 0 } : undefined
  const displayScore = terminalScore ?? whiteScore(leader?.score, chess.turn())
  const displayText = chess.isCheckmate() && chess.turn() === 'w' ? '−M0' : scoreLabel(displayScore)
  const evalPercentage = chess.isCheckmate() ? chess.turn() === 'w' ? 5 : 95 : displayScore ? displayScore.kind === 'mate' ? displayScore.value > 0 ? 95 : 5 : Math.max(5, Math.min(95, 50 + 45 * Math.tanh(displayScore.value / 400))) : 50
  const arrow = !chess.isGameOver() && leader?.pv[0] && /^[a-h][1-8][a-h][1-8]/.test(leader.pv[0]) ? [{ startSquare: leader.pv[0].slice(0, 2), endSquare: leader.pv[0].slice(2, 4), color: '#67d2d0bb' }] : []

  function update(action: () => GameDocument): boolean {
    try { onChange(action()); setMessage(''); return true }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to change the position'); return false }
  }
  function go(nodeId: string) { update(() => selectNode(game, nodeId)) }
  function endNode(): string {
    let node = current
    while (node.childIds.length) node = game.nodes[node.childIds[0]]
    return node.id
  }
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLElement && (event.target.closest('input,textarea,select,[contenteditable="true"],button') || event.target.isContentEditable)) return
      const node = game.nodes[game.currentId]
      const next = event.key === 'ArrowLeft' ? node.parentId : event.key === 'ArrowRight' ? node.childIds[0] : event.key === 'Home' ? game.rootId : event.key === 'End' ? endNode() : null
      if (next) { event.preventDefault(); onChange(selectNode(game, next)) }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [game, onChange])

  useEffect(() => {
    engine.controller.newGame(game.id)
    if (!enabled) return
    active.current = true
    setLines({})
    const token = ++searchToken.current
    const abort = new AbortController()
    let flush: ReturnType<typeof setTimeout> | undefined
    let latest: Record<number, Extract<EngineEvent, { type: 'info' }>> = {}
    const timer = setTimeout(async () => {
      if (chess.isGameOver()) { setLines({}); setEngineMessage(statusOf(chess)); setRunning(false); setEnabled(false); return }
      try {
        setLines({}); setRunning(true); setEngineMessage('Searching…')
        const descriptor = await engine.ensureReady()
        if (abort.signal.aborted || token !== searchToken.current) return
        for await (const event of engine.controller.search('analysis', {
          requestId: crypto.randomUUID(), engineId: descriptor.id, position,
          settings: { ...engine.settings, strength: { kind: 'full' } }, limit: engine.limit,
        }, abort.signal)) {
          if (abort.signal.aborted || token !== searchToken.current) break
          if (event.type === 'info') {
            latest = { ...latest, [event.multiPv]: event }
            if (!flush) flush = setTimeout(() => { setLines(latest); flush = undefined }, 100)
          } else if (event.type === 'error') { setEngineMessage(event.message); setRunning(false); active.current = false; setEnabled(false) }
          else if (event.type === 'done') { setEngineMessage(event.reason === 'limit' ? 'Search limit reached' : 'Search complete'); setRunning(false); active.current = false; setEnabled(false) }
        }
      } catch (error) {
        if (!abort.signal.aborted && token === searchToken.current) {
          setEngineMessage(error instanceof Error ? error.message : 'Engine unavailable'); setRunning(false); active.current = false; setEnabled(false)
        }
      } finally { if (latest[1] && token === searchToken.current) setLines(latest) }
    }, 150)
    return () => { clearTimeout(timer); clearTimeout(flush); abort.abort(); void engine.controller.cancel('analysis') }
  }, [enabled, game.id, game.currentId, engine.controller, engine.descriptor, engine.settings, engine.limit, engine.provider])
  useEffect(() => { setLines({}) }, [game.id, game.currentId])

  useEffect(() => {
    function visibility() {
      if (document.hidden && active.current) { active.current = false; searchToken.current++; setRunning(false); setEnabled(false); setEngineMessage('Paused while app is hidden. Press Analyze to resume.'); void engine.controller.cancel('analysis') }
    }
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [engine.controller])

  function stop() { active.current = false; searchToken.current++; setRunning(false); setEnabled(false); setEngineMessage('Analysis stopped'); void engine.controller.cancel('analysis') }
  function start() { active.current = true; setEnabled(true) }
  function move(uci: string) { update(() => appendMove(game, uci)) }
  function renderLine(startId: string, variation = false): ReactNode {
    const items: ReactNode[] = []
    let id: string | undefined = startId
    let first = true
    while (id) {
      const node: GameNode = game.nodes[id]
      const parent = game.nodes[node.parentId!]
      const [, side, , , , fullMove] = parent.fen.split(' ')
      const number = `${fullMove}${side === 'b' ? '…' : '.'}`
      items.push(<div className="move-item" key={id}>
        <span className="move-number">{number}</span>
        <button className={`move-chip ${game.currentId === id ? 'selected' : ''}`} onClick={() => go(node.id)} aria-current={game.currentId === id ? 'step' : undefined} title={node.comments.join(' · ') || node.san || ''}>{node.san}{grades?.[id] ? <span className={`grade grade-${grades[id].label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{grades[id].label}</span> : node.nags.length > 0 && <span className="move-nags">{node.nags.map(nag => `$${nag}`).join(' ')}</span>}</button>
        {(parent.childIds[0] !== id || node.childIds.length > 1) && <span className="move-actions">
          {parent.childIds[0] !== id && <button title={`Promote ${node.san} to main line`} aria-label={`Promote ${node.san} to main line`} onClick={() => update(() => promoteVariation(game, node.id))}>↑</button>}
          <button title={`Delete branch from ${node.san}`} aria-label={`Delete branch from ${node.san}`} onClick={() => {
            if (window.confirm(`Delete ${node.san} and all moves after it? This cannot be undone.`)) update(() => deleteVariation(game, node.id))
          }}>×</button>
        </span>}
        {node.comments.length > 0 && <p className="move-comment">{node.comments.join(' · ')}</p>}
      </div>)
      if (!(variation && first)) for (const alternative of parent.childIds.slice(1)) items.push(<div className="variation" key={`var-${alternative}`}>{renderLine(alternative, true)}</div>)
      id = node.childIds[0]
      first = false
    }
    return items
  }

  return <section className="analysis-layout" aria-label="Analysis workspace">
    <div className="board-column">
      <div className="player-strip"><span className="player-avatar">{topName.charAt(0).toUpperCase()}</span><div><strong>{topName}</strong><span className="material">{topCaptures}{topAdvantage > 0 ? ` +${topAdvantage}` : ''}</span></div></div>
      <div className="board-and-eval">
        <div className={`evaluation-bar ${orientation === 'black' ? 'flipped' : ''}`} role="meter" aria-label="Engine evaluation from White's perspective" aria-valuemin={0} aria-valuemax={100} aria-valuenow={evalPercentage} aria-valuetext={displayText}>
          <div className="eval-light" style={{ height: `${evalPercentage}%` }} /><span>{displayText}</span>
        </div>
        <AnalysisBoard game={game} onMove={move} orientation={orientation} arrows={arrow} />
      </div>
      <div className="player-strip"><span className="player-avatar">{bottomName.charAt(0).toUpperCase()}</span><div><strong>{bottomName}</strong><span className="material">{bottomCaptures}{bottomAdvantage > 0 ? ` +${bottomAdvantage}` : ''}</span></div></div>
      <div className="board-tools"><span className="status-pill">{statusOf(chess)}</span><button onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} aria-label="Flip board">⇅ Flip</button></div>
    </div>
    <aside className="analysis-pane">
      <header className="pane-heading"><div><span className="eyebrow">ANALYSIS ROOM</span><h1>{game.title}</h1><span className="engine-identity">{engine.provider === 'remote' ? 'Remote' : 'Local'} · {engine.descriptor?.name || engine.status}</span></div></header>
      <div className="pane-tabs" role="tablist" aria-label="Analysis panels">{(['moves', 'engine', 'review'] as const).map(tab => <button key={tab} role="tab" aria-selected={pane === tab} className={pane === tab ? 'active' : ''} onClick={() => setPane(tab)}>{tab}</button>)}</div>
      {pane === 'moves' && <div className="pane-content" role="tabpanel" aria-label="Moves">
        <div className="moves-header"><strong>Move history</strong><small>{Object.keys(game.nodes).length - 1} moves & positions</small></div>
        <div className="move-scroll"><button className={`root-move ${game.currentId === game.rootId ? 'selected' : ''}`} onClick={() => go(game.rootId)}>Starting position</button>{game.nodes[game.rootId].childIds[0] ? renderLine(game.nodes[game.rootId].childIds[0]) : <p className="muted">Make a move on the board to begin. Alternate moves create variations.</p>}</div>
        <div className="navigation-controls" aria-label="Move navigation"><button aria-label="First move" onClick={() => go(game.rootId)}>⟪</button><button aria-label="Previous move" disabled={!current.parentId} onClick={() => current.parentId && go(current.parentId)}>‹</button><button aria-label="Next move" disabled={!current.childIds.length} onClick={() => current.childIds[0] && go(current.childIds[0])}>›</button><button aria-label="Last move" onClick={() => go(endNode())}>⟫</button></div>
        <form className="move-entry" onSubmit={event => { event.preventDefault(); if (moveText.trim() && update(() => appendMove(game, moveText.trim()))) setMoveText('') }}><label htmlFor="move-input">Enter SAN or coordinate move</label><div><input id="move-input" value={moveText} onChange={event => setMoveText(event.target.value)} placeholder="Nf3 or g1f3" autoComplete="off" /><button type="submit">Play</button></div></form>
        {current.comments.length > 0 && <div className="comment-card"><strong>Move comments</strong><p>{current.comments.join('\n')}</p></div>}
        <div className="position-copy"><button onClick={async () => { try { await navigator.clipboard.writeText(exportFen(game)); setMessage('Position FEN copied') } catch { setMessage('Clipboard unavailable; select and copy the FEN field') } }}>Copy FEN</button><input readOnly value={exportFen(game)} aria-label="Selected position FEN" onFocus={event => event.target.select()} /></div>
        {message && <p className="inline-message" role="status">{message}</p>}
      </div>}
      {pane === 'engine' && <div className="pane-content engine-panel" role="tabpanel" aria-label="Engine"><div className="engine-summary"><span className="eyebrow">WHITE POINT OF VIEW</span><strong>{displayText}</strong><span>{leader && !chess.isGameOver() ? `Depth ${leader.depth} · ${leader.nodes?.toLocaleString() || '—'} nodes` : chess.isGameOver() ? statusOf(chess) : engineMessage}</span></div>
        <div className="engine-controls"><button className="primary-button" onClick={running ? stop : start}>{running ? '■ Stop analysis' : '▶ Analyze position'}</button></div>
        {Object.values(lines).sort((a, b) => a.multiPv - b.multiPv).map(info => <div className="pv-line" key={info.multiPv}><span className="pv-rank">{info.multiPv}</span><strong>{scoreLabel(whiteScore(info.score, chess.turn()))}</strong><span>{pvSan(position, info.pv) || 'No legal continuation yet'}</span></div>)}
        <EngineSettingsPanel />
        <p className="muted">Scores always show White’s perspective. Engine positions include the full move history.</p>
      </div>}
      {pane === 'review' && <div className="pane-content" role="tabpanel" aria-label="Review">{reviewPanel || <div className="empty-pane"><strong>Game review</strong><p>Complete a game, then run a review to understand each decision.</p></div>}</div>}
    </aside>
  </section>
}
