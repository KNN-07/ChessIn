import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBackwardFast, faBackwardStep, faForwardStep, faForwardFast, faRotate, faListUl, faMicrochip, faChartLine, faPlay, faStop, faPause, faLightbulb, faShareNodes, faGear, faEllipsis, faArrowUp, faTrashCan, faChessPawn, faCopy } from '@fortawesome/free-solid-svg-icons'
import { appendMove, deleteVariation, exportFen, getPosition, promoteVariation, reconstruct, selectNode, type GameDocument, type GameNode, type PositionSpec } from '@chessin/core/game'
import type { EngineEvent, EngineScore } from '@chessin/core/engine'
import { Chess } from 'chess.js'
import { AnalysisBoard } from '../../components/AnalysisBoard'
import { ChessPlayerRow } from '../../components/ChessPlayerRow'
import { useEngine } from '../../engine/EngineContext'
import { mainlineNodes, reviewSummary, type ReviewMove } from '@chessin/core/review'
import { MoveQualityBadge } from '../../components/MoveQualityBadge'
import { QuickEngineSettings } from '../../engine/QuickEngineSettings'
import './analysis.css'

const analysisTabs = [
  { id: 'moves', label: 'Moves', icon: faListUl },
  { id: 'engine', label: 'Engine', icon: faMicrochip },
  { id: 'review', label: 'Review', icon: faChartLine },
] as const

export interface AnalysisPageProps {
  game: GameDocument
  onChange: (game: GameDocument) => void
  onOpenSettings: () => void
  reviewPanel?: ReactNode
  grades?: Record<string, ReviewMove>
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

export function AnalysisPage({ game, onChange, onOpenSettings, reviewPanel, grades, initialPane = 'moves' }: AnalysisPageProps) {
  const chess = useMemo(() => reconstruct(game), [game])
  const position = useMemo(() => getPosition(game), [game])
  const engine = useEngine()
  const panelId = useId()
  const [orientation, setOrientation] = useState<'white' | 'black'>('white')
  const [pane, setPane] = useState<'moves' | 'engine' | 'review'>(initialPane)
  const [moveText, setMoveText] = useState('')
  const [message, setMessage] = useState('')
  const [running, setRunning] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [lines, setLines] = useState<Record<number, Extract<EngineEvent, { type: 'info' }>>>({})
  const [engineMessage, setEngineMessage] = useState('Start analysis to see engine lines.')
  const active = useRef(false)
  const searchToken = useRef(0)
  const moveList = useRef<HTMLDivElement>(null)
  const current = game.nodes[game.currentId]
  const assessment = grades?.[game.currentId]
  const mainline = useMemo(() => mainlineNodes(game), [game])
  const quality = useMemo(() => reviewSummary({ moves: grades ?? {} }, game), [grades, game])
  const reviewedCount = mainline.filter(id => grades?.[id]).length
  const currentPly = position.moves.length
  const moveNumber = current.parentId ? game.nodes[current.parentId].fen.split(' ')[5] : ''
  const moveSide = current.parentId ? game.nodes[current.parentId].fen.split(' ')[1] : ''
  const moveCaption = current.san ? `${moveNumber}${moveSide === 'b' ? '…' : '.'} ${current.san}` : 'Starting position'
  const material = useMemo(() => captured(chess, game.rootFen), [chess, game.rootFen])
  useEffect(() => {
    const list = moveList.current
    if (!list) return
    const observer = new ResizeObserver(() => {
      if (game.currentId === game.rootId) { list.scrollTop = 0; return }
      const selected = list.querySelector('.move-chip.selected')
      if (!selected) return
      const row = selected.getBoundingClientRect()
      const viewport = list.getBoundingClientRect()
      if (row.bottom > viewport.bottom - 4) list.scrollTop += row.bottom - viewport.bottom + 4
      else if (row.top < viewport.top + 4) list.scrollTop -= viewport.top - row.top + 4
    })
    observer.observe(list)
    return () => observer.disconnect()
  }, [game.currentId, game.rootId, game.nodes, pane])
  const topName = orientation === 'white' ? game.headers.Black || 'Black pieces' : game.headers.White || 'White pieces'
  const bottomName = orientation === 'white' ? game.headers.White || 'White pieces' : game.headers.Black || 'Black pieces'
  const topCaptures = orientation === 'white' ? material.black : material.white
  const bottomCaptures = orientation === 'white' ? material.white : material.black
  const topAdvantage = orientation === 'white' ? -material.advantage : material.advantage
  const bottomAdvantage = -topAdvantage
  const leader = lines[1]
  const terminalScore: EngineScore | undefined = chess.isCheckmate() ? { kind: 'mate', value: 0 } : chess.isDraw() ? { kind: 'cp', value: 0 } : undefined
  const displayScore = terminalScore ?? whiteScore(leader?.score, chess.turn()) ?? assessment?.whiteScore
  const usingReviewScore = !terminalScore && !leader?.score && !!assessment?.whiteScore
  const displayText = chess.isCheckmate() && chess.turn() === 'w' ? '−M0' : scoreLabel(displayScore)
  const evalPercentage = chess.isCheckmate() ? chess.turn() === 'w' ? 5 : 95 : displayScore ? displayScore.kind === 'mate' ? displayScore.value > 0 ? 95 : 5 : Math.max(5, Math.min(95, 50 + 45 * Math.tanh(displayScore.value / 400))) : 50
  const arrow = !chess.isGameOver() && leader?.pv[0] && /^[a-h][1-8][a-h][1-8]/.test(leader.pv[0]) ? [{ startSquare: leader.pv[0].slice(0, 2), endSquare: leader.pv[0].slice(2, 4), color: '#f5ad32bb' }] : []
  const graph = mainline.map((id, index) => {
    const grade = grades?.[id]
    const score = grade?.whiteScore
    if (!score) return null
    const cp = score.kind === 'mate' ? Math.sign(score.value || 1) * 1000 : score.value
    return { id, x: 4 + index * 392 / Math.max(1, mainline.length - 1), y: 55 - 49 * Math.tanh(cp / 380), grade: grade! }
  })
  const graphSegments: NonNullable<typeof graph[number]>[][] = []
  for (const point of graph) {
    if (!point) { if (graphSegments.at(-1)?.length) graphSegments.push([]); continue }
    if (!graphSegments.length) graphSegments.push([])
    graphSegments.at(-1)!.push(point)
  }
  useEffect(() => {
    if (!playing) return
    if (!current.childIds[0]) { setPlaying(false); return }
    const timer = setTimeout(() => onChange(selectNode(game, current.childIds[0])), 1100)
    return () => clearTimeout(timer)
  }, [playing, game, onChange, current])
  useEffect(() => { setShowHint(false) }, [game.currentId])
  const clocks: Record<string, string> = {}
  let clockNode: GameNode | undefined = current
  while (clockNode?.parentId && (!clocks.w || !clocks.b)) {
    const side = game.nodes[clockNode.parentId].fen.split(' ')[1]
    const clock = clockNode.comments.join(' ').match(/\[%clk\s+([\d:.]+)\]/)?.[1]
    if (clock && !clocks[side]) clocks[side] = clock.replace(/^0:/, '')
    clockNode = game.nodes[clockNode.parentId]
  }
  const destination = current.uci?.slice(2, 4)
  const badgeFile = destination ? destination.charCodeAt(0) - 97 : 0
  const badgeRank = destination ? Number(destination[1]) - 1 : 0

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
  function choosePane(next: typeof pane) {
    if (next === 'review' && enabled) stop()
    setPane(next)
  }

  function moveCell(node?: GameNode): ReactNode {
    if (!node) return <span className="notation-empty" aria-hidden="true">—</span>
    const grade = grades?.[node.id]
    const parent = game.nodes[node.parentId!]
    return <div className="notation-cell">
      <button className={`move-chip ${game.currentId === node.id ? 'selected' : ''}`} onClick={() => go(node.id)}
        aria-current={game.currentId === node.id ? 'step' : undefined} aria-label={`${node.san}${grade ? ` · ${grade.label}` : ''}`} title={node.comments.join(' · ') || node.san || ''}>
        <span className="notation-san">{node.san?.replace(/^[KQRBN]/, piece => ({ K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞' })[piece]! + ' ')}</span>
        {grade ? <MoveQualityBadge label={grade.label} decorative /> : node.nags.length > 0 && <span className="move-nags">{node.nags.map(nag => `$${nag}`).join(' ')}</span>}
        {grade?.whiteScore && <span className="notation-score" aria-label={`White evaluation ${scoreLabel(grade.whiteScore)}`}>{scoreLabel(grade.whiteScore)}</span>}
      </button>
      <details className="notation-options"><summary aria-label={`Options for ${node.san}`} title={`Options for ${node.san}`}><FontAwesomeIcon icon={faEllipsis} /></summary><div>
        {parent.childIds[0] !== node.id && <button onClick={() => update(() => promoteVariation(game, node.id))}><FontAwesomeIcon icon={faArrowUp} /> Promote to main line</button>}
        <button onClick={() => { if (window.confirm(`Delete ${node.san} and all moves after it? This cannot be undone.`)) update(() => deleteVariation(game, node.id)) }}><FontAwesomeIcon icon={faTrashCan} /> Delete branch</button>
      </div></details>
    </div>
  }

  function renderLine(startId: string, variation = false): ReactNode {
    const rows: ReactNode[] = []
    let id: string | undefined = startId
    let first = true
    let row: { number: string; white?: GameNode; black?: GameNode } | undefined
    let notes: ReactNode[] = []
    const flush = () => {
      if (!row) return
      rows.push(<div className="notation-row" key={`${row.white?.id ?? row.black!.id}-row`}><span className="notation-number">{row.number}.</span>{moveCell(row.white)}{moveCell(row.black)}</div>, ...notes)
      row = undefined
      notes = []
    }
    while (id) {
      const node: GameNode = game.nodes[id]
      const parent = game.nodes[node.parentId!]
      const [, side, , , , number] = parent.fen.split(' ')
      if (row && row.number !== number) flush()
      row ??= { number }
      if (side === 'w') row.white = node
      else row.black = node
      if (node.comments.length) notes.push(<p className="notation-comment" key={`${node.id}-comment`}><strong>{node.san}</strong> {node.comments.join(' · ')}</p>)
      if (!(variation && first)) for (const alternative of parent.childIds.slice(1)) {
        notes.push(<div className="notation-variation" key={`var-${alternative}`}><span className="variation-caption">VARIATION</span>{renderLine(alternative, true)}</div>)
      }
      if (side === 'b') flush()
      id = node.childIds[0]
      first = false
    }
    flush()
    return rows
  }

  return <section className="analysis-layout chess-layout" aria-label="Analysis workspace">
    <div className="board-column">
      <ChessPlayerRow name={topName} side={orientation === 'white' ? 'black' : 'white'} rating={game.headers[orientation === 'white' ? 'BlackElo' : 'WhiteElo']} detail={<span className="material">{topCaptures}{topAdvantage > 0 ? ` +${topAdvantage}` : ''}</span>} clock={clocks[orientation === 'white' ? 'b' : 'w']} active={chess.turn() === (orientation === 'white' ? 'b' : 'w')} />
      <div className="board-and-eval">
        <div className={`evaluation-bar ${orientation === 'black' ? 'flipped' : ''}`} role="meter" aria-label={`${usingReviewScore ? 'Reviewed move score' : 'Position evaluation'} from White's perspective`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={evalPercentage} aria-valuetext={displayText}>
          <div className="eval-light" style={{ height: `${evalPercentage}%` }} /><span>{displayText}</span>
        </div>
        <div className="annotated-board"><AnalysisBoard game={game} onMove={move} orientation={orientation} arrows={arrow} />
          {assessment && destination && <MoveQualityBadge label={assessment.label} className="board-quality-badge" style={{ left: `${((orientation === 'white' ? badgeFile : 7 - badgeFile) + .88) * 12.5}%`, top: `${((orientation === 'white' ? 7 - badgeRank : badgeRank) + .05) * 12.5}%` }} />}
        </div>
      </div>
      <ChessPlayerRow name={bottomName} side={orientation} rating={game.headers[orientation === 'white' ? 'WhiteElo' : 'BlackElo']} detail={<span className="material">{bottomCaptures}{bottomAdvantage > 0 ? ` +${bottomAdvantage}` : ''}</span>} clock={clocks[orientation === 'white' ? 'w' : 'b']} active={chess.turn() === (orientation === 'white' ? 'w' : 'b')} />
    </div>
    <aside className="analysis-pane chess-panel">
      <header className="pane-heading chess-panel-heading"><div className="analysis-heading-copy"><span className="eyebrow">ANALYSIS ROOM</span><h1 title={game.title}>{game.title}</h1><span className="engine-identity"><FontAwesomeIcon icon={faMicrochip} /> {engine.provider === 'remote' ? 'Remote' : 'Local'} · {engine.descriptor?.name || 'Engine not initialized'}</span></div><button onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} aria-label="Flip board" title="Flip board"><FontAwesomeIcon icon={faRotate} /></button><button onClick={onOpenSettings} aria-label="Engine settings" title="Engine settings"><FontAwesomeIcon icon={faGear} /></button></header>
      <div className="coach-section">
        <article className="coach-card" aria-label="Selected move feedback">
          <header>{assessment ? <MoveQualityBadge label={assessment.label} decorative /> : <span className="move-quality-mark quality-unreviewed" aria-hidden="true"><FontAwesomeIcon icon={faChessPawn} /></span>}<strong>{assessment?.label ?? (current.san ? 'Your move' : 'Welcome')}</strong><span className="coach-score">{displayText}</span></header>
          <p>{assessment?.explanation ?? (current.san ? 'Review this game to discover your best moves and learn from the critical moments.' : 'Make a move or import a game to start exploring. Your move-by-move feedback will appear here.')}</p>
          {showHint && <p className="coach-hint">{assessment?.bestSan?.length ? `Best continuation: ${assessment.bestSan.join(' ')}` : 'Open the Engine tab and analyze this position to find the best continuation.'}</p>}
          <small>{moveCaption}{assessment?.actualDepth ? ` · depth ${assessment.actualDepth}` : ''}</small>
        </article>
      </div>
      <div className="coach-actions"><button onClick={() => setShowHint(!showHint)} aria-label="Show hint" aria-pressed={showHint}><FontAwesomeIcon icon={faLightbulb} /> Hint</button><button onClick={() => choosePane('review')}><FontAwesomeIcon icon={faChartLine} /> Review game</button></div>
      <div className={`analysis-score-strip ${running ? 'is-searching' : ''}`}><div><span className="score-perspective">{usingReviewScore ? 'WHITE MOVE SCORE' : 'WHITE EVALUATION'}</span><strong>{displayText}</strong></div><div className="score-search-info"><span>{chess.isGameOver() ? statusOf(chess) : leader ? `Depth ${leader.depth} · ${leader.nodes?.toLocaleString() ?? '—'} nodes` : assessment?.actualDepth ? `Move review · depth ${assessment.actualDepth}` : 'Position not analyzed'}</span><button onClick={running || enabled ? stop : start} disabled={pane === 'review' || chess.isGameOver()} aria-label={running || enabled ? 'Stop analysis' : 'Analyze position'}><FontAwesomeIcon icon={running || enabled ? faStop : faPlay} />{running || enabled ? 'Stop' : 'Analyze'}</button></div></div>
      <div className="pane-tabs chess-tabs" role="tablist" aria-label="Analysis panels">{analysisTabs.map((tab, index) => <button key={tab.id} id={`${panelId}-${tab.id}-tab`} role="tab" aria-controls={`${panelId}-${tab.id}-panel`} aria-selected={pane === tab.id} tabIndex={pane === tab.id ? 0 : -1} className={pane === tab.id ? 'active' : ''} onClick={() => choosePane(tab.id)} onKeyDown={event => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? analysisTabs.length - 1 : offset ? (index + offset + analysisTabs.length) % analysisTabs.length : -1
        if (next < 0) return
        event.preventDefault(); choosePane(analysisTabs[next].id); document.getElementById(`${panelId}-${analysisTabs[next].id}-tab`)?.focus()
      }}><FontAwesomeIcon icon={tab.icon} />{tab.label}</button>)}</div>
      {pane === 'moves' && <div className="pane-content analysis-moves-panel" role="tabpanel" id={`${panelId}-moves-panel`} aria-labelledby={`${panelId}-moves-tab`}>
        <div className="move-list-caption"><strong>Move summary</strong><span>{mainline.length} plies · {reviewedCount ? `${reviewedCount} reviewed` : 'Not reviewed'}</span></div>
        <div className="notation-heading" aria-hidden="true"><span>#</span><span>White</span><span>Black</span></div>
        <div className="move-scroll" ref={moveList}><button className={`root-move ${game.currentId === game.rootId ? 'selected' : ''}`} onClick={() => go(game.rootId)}>Starting position</button>{game.nodes[game.rootId].childIds[0] ? renderLine(game.nodes[game.rootId].childIds[0]) : <div className="analysis-empty-moves"><FontAwesomeIcon icon={faChessPawn} /><strong>Your next move starts here.</strong><p>Move a piece or enter notation to start a main line, then explore alternatives.</p></div>}</div>
      </div>}
      {pane === 'engine' && <div className="pane-content engine-panel" role="tabpanel" id={`${panelId}-engine-panel`} aria-labelledby={`${panelId}-engine-tab`}>
        <div className="move-list-caption"><strong>Top continuations</strong><span>{Object.keys(lines).length ? `${Object.keys(lines).length} lines` : 'Full strength'}</span></div>
        <p className="analysis-engine-status" role="status">{engineMessage}</p>
        {Object.values(lines).sort((a, b) => a.multiPv - b.multiPv).map(info => <div className="pv-line" key={info.multiPv}><span className="pv-rank">{info.multiPv}</span><div className="pv-score"><strong>{scoreLabel(whiteScore(info.score, chess.turn()))}</strong><small>depth {info.depth}</small></div><span>{pvSan(position, info.pv) || 'No legal continuation yet'}</span></div>)}
        {!Object.keys(lines).length && <div className="analysis-empty-moves"><FontAwesomeIcon icon={faMicrochip} /><strong>Find the strongest continuation.</strong><p>Start analysis above for real engine lines, evaluation and best-move arrows.</p></div>}
        <p className="quality-disclaimer">Scores use White’s perspective. Mate distances and score bounds are preserved.</p>
      </div>}
      {pane === 'review' && <div className="pane-content" role="tabpanel" id={`${panelId}-review-panel`} aria-labelledby={`${panelId}-review-tab`}>{reviewPanel || <div className="empty-pane"><strong>Game review</strong><p>Review a game to understand each decision.</p></div>}</div>}
      {message && <p className="analysis-message" role="status">{message}</p>}
      <div className="review-timeline" aria-label="Game evaluation timeline">
        {graph.some(Boolean) ? <svg viewBox="0 0 400 110" role="group" aria-label="Evaluation graph">
          <rect width="400" height="110" fill="var(--surface)" /><line x1="0" y1="55" x2="400" y2="55" stroke="var(--muted)" />
          {graphSegments.filter(segment => segment.length).map(segment => <path key={segment[0].id} d={`M${segment[0].x},110 ${segment.map(point => `L${point.x},${point.y}`).join(' ')} L${segment.at(-1)!.x},110 Z`} fill="#cbd8bc" />)}
          {graph.filter((point): point is NonNullable<typeof point> => !!point).map(point => <g key={point.id} role="button" tabIndex={0} aria-label={`Select ${game.nodes[point.id].san}, ${scoreLabel(point.grade.whiteScore)}`} onClick={() => { setPlaying(false); go(point.id) }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPlaying(false); go(point.id) } }}>
            {point.id === game.currentId && <line x1={point.x} x2={point.x} y1="0" y2="110" className={`graph-cursor quality-${point.grade.label.toLowerCase()}`} />}
            <circle cx={point.x} cy={point.y} r="5" className={`graph-point quality-${point.grade.label.toLowerCase()}`} /><circle cx={point.x} cy={point.y} r="9" fill="transparent" />
          </g>)}
        </svg> : <div className="timeline-empty"><FontAwesomeIcon icon={faChartLine} /><span>Review your game to see the evaluation graph</span></div>}
      </div>
      <div className="review-playback" aria-label="Move navigation">
        <button aria-label="First move" disabled={!current.parentId} onClick={() => { setPlaying(false); go(game.rootId) }}><FontAwesomeIcon icon={faBackwardFast} /></button>
        <button aria-label="Previous move" disabled={!current.parentId} onClick={() => { setPlaying(false); current.parentId && go(current.parentId) }}><FontAwesomeIcon icon={faBackwardStep} /></button>
        <button aria-label={playing ? 'Pause playback' : 'Play moves'} disabled={!playing && !current.childIds.length} onClick={() => setPlaying(!playing)}><FontAwesomeIcon icon={playing ? faPause : faPlay} /></button>
        <button aria-label="Next move" disabled={!current.childIds.length} onClick={() => { setPlaying(false); current.childIds[0] && go(current.childIds[0]) }}><FontAwesomeIcon icon={faForwardStep} /></button>
        <button aria-label="Last move" disabled={!current.childIds.length} onClick={() => { setPlaying(false); go(endNode()) }}><FontAwesomeIcon icon={faForwardFast} /></button>
      </div>
      <footer className="review-footer"><span>{currentPly} / {Math.max(mainline.length, currentPly)} · {statusOf(chess)}</span><button onClick={async () => { try { await navigator.clipboard.writeText(exportFen(game)); setMessage('Position FEN copied') } catch { setMessage('Clipboard unavailable; copy the FEN from Position tools below.') } }}><FontAwesomeIcon icon={faShareNodes} /> Share position</button></footer>
      <details className="analysis-tools"><summary>Position tools & game quality</summary>
        <p className="quality-disclaimer">ChessIn quality is based on reviewed moves, not Elo or Chess.com accuracy.{reviewedCount ? ` Coverage: White ${quality.white.graded}/${quality.white.total}, Black ${quality.black.graded}/${quality.black.total} non-forced moves. Move-review mate distances begin before the played move.` : ''}</p>
        <form className="move-entry" onSubmit={event => { event.preventDefault(); if (moveText.trim() && update(() => appendMove(game, moveText.trim()))) setMoveText('') }}><label htmlFor="move-input">Enter SAN or coordinate move</label><div><input id="move-input" value={moveText} onChange={event => setMoveText(event.target.value)} placeholder="Nf3 or g1f3" autoComplete="off" /><button type="submit" aria-label="Play move"><FontAwesomeIcon icon={faPlay} /></button></div></form>
        <details className="analysis-position-details"><summary>Position FEN</summary><div className="position-copy"><button aria-label="Copy FEN" onClick={async () => { try { await navigator.clipboard.writeText(exportFen(game)); setMessage('Position FEN copied') } catch { setMessage('Clipboard unavailable; select and copy the FEN field') } }}><FontAwesomeIcon icon={faCopy} /></button><input readOnly value={exportFen(game)} aria-label="Selected position FEN" onFocus={event => event.target.select()} /></div></details>
        <div className="analysis-quality-strip" aria-label="ChessIn quality summary">{(['white', 'black'] as const).map(side => <div key={side}><span><i className={`side-dot ${side}`} />{game.headers[side === 'white' ? 'White' : 'Black'] || (side === 'white' ? 'White' : 'Black')}</span><strong>{quality[side].quality ?? '—'}<small> quality</small></strong></div>)}</div>
        <QuickEngineSettings disabled={pane === 'review'} onOpenSettings={onOpenSettings} />
      </details>
    </aside>
  </section>
}
