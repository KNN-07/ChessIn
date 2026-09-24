import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRight, faChartLine, faChessBoard, faCircleCheck, faClockRotateLeft, faPause, faPlay, faTrophy } from '@fortawesome/free-solid-svg-icons'
import type { GameDocument } from '@chessin/core/game'
import type { EngineScore } from '@chessin/core/engine'
import { MoveQualityBadge } from '../../components/MoveQualityBadge'
import { mainlineNodes, matchesReview, reviewSignature, reviewSummary, type ReviewReport, type ReviewMove } from '@chessin/core/review'
import { useEngine } from '../../engine/EngineContext'
import { getReview, putReview } from '../../storage/db'
import { prepareReview, ReviewInterrupted, runReview } from './review-runner'
import './ReviewPanel.css'

export interface ReviewPanelProps {
  game: GameDocument
  onSelect: (nodeId: string) => void
  onGrades?: (grades: Record<string, ReviewMove>) => void
}

const critical: Record<string, true> = { Brilliant: true, Great: true, Inaccuracy: true, Mistake: true, Blunder: true, Uncertain: true }
const classifications = ['Brilliant', 'Great', 'Best', 'Excellent', 'Good', 'Inaccuracy', 'Mistake', 'Blunder', 'Forced', 'Uncertain'] as const

function moveName(game: GameDocument, id: string): string {
  const node = game.nodes[id]
  const before = game.nodes[node.parentId!].fen.split(' ')
  return `${before[5]}${before[1] === 'b' ? '…' : '.'} ${node.san}`
}

function scoreText(score?: EngineScore): string {
  if (!score) return '—'
  const bound = score.bound === 'lower' ? '≥' : score.bound === 'upper' ? '≤' : ''
  if (score.kind === 'mate') return `${bound}${score.value < 0 ? '−' : ''}M${Math.abs(score.value)}`
  return `${bound}${score.value >= 0 ? '+' : '−'}${(Math.abs(score.value) / 100).toFixed(2)}`
}

export function ReviewPanel({ game, onSelect, onGrades }: ReviewPanelProps) {
  const tabsId = useId()
  const [tab, setTab] = useState<'overview' | 'moves'>('overview')
  const engine = useEngine()
  const [depth, setDepth] = useState(16)
  const [timeMs, setTimeMs] = useState(3000)
  const [report, setReport] = useState<ReviewReport | null>(null)
  const reportRef = useRef<ReviewReport | null>(null)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState('Review uses exact, completed engine scores; analysis is paused while reviewing.')
  const [storageWarning, setStorageWarning] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const runId = useRef(0)
  const gradesKey = useRef('')
  const preparing = useRef(false)
  const activeSignatureKey = useRef<string | null>(null)
  const latestEngine = useRef(engine)
  latestEngine.current = engine
  const latestGame = useRef(game)
  latestGame.current = game
  const nodeIds = useMemo(() => mainlineNodes(game), [game])
  const supportedPv = engine.descriptor?.options.some(option => option.name.toLowerCase() === 'multipv' && option.type === 'spin' && (option.min ?? 1) <= 2 && (option.max ?? 2) >= 2) ?? false
  const settings = useMemo(() => ({ ...engine.settings, multiPv: supportedPv ? 2 : undefined, strength: { kind: 'full' as const } }), [engine.settings, supportedPv])
  const signature = useMemo(() => engine.descriptor ? reviewSignature(game, engine.descriptor, engine.provider, settings, depth, timeMs) : null,
    [game, engine.descriptor, engine.provider, settings, depth, timeMs])
  const signatureKey = signature ? JSON.stringify({ ...signature, revision: 0 }) : ''

  useEffect(() => {
    if (preparing.current || activeSignatureKey.current === signatureKey) return
    const sequence = ++runId.current
    abortRef.current?.abort()
    abortRef.current = null
    engine.controller.setReviewActive(false)
    void engine.controller.cancel('review')
    setRunning(false)
    activeSignatureKey.current = null
    reportRef.current = null
    setReport(null)
    if (!signature) return
    void getReview<ReviewReport>(game.id).then(saved => {
      if (sequence === runId.current && matchesReview(saved, signature)) {
        reportRef.current = saved!
        setReport(saved!)
        setMessage(saved!.status === 'completed' ? 'Stored review complete.' : 'Stored review loaded. Resume to continue.')
      }
    }).catch(() => {
      if (sequence === runId.current) setStorageWarning('Review storage unavailable; completed progress will not survive a reload. Export your game for backup.')
    })
  }, [signatureKey, game.id, engine.controller])
  useEffect(() => () => { ++runId.current; abortRef.current?.abort(); abortRef.current = null; engine.controller.setReviewActive(false); void engine.controller.cancel('review') }, [engine.controller])

  useEffect(() => {
    const grades = signature && matchesReview(report ?? undefined, signature) ? report!.moves : {}
    const key = JSON.stringify(grades)
    if (gradesKey.current !== key) { gradesKey.current = key; onGrades?.(grades) }
  }, [report, onGrades, signatureKey])

  useEffect(() => {
    function visibility() {
      if (!document.hidden || !abortRef.current) return
      abortRef.current.abort()
      engine.controller.setReviewActive(false)
      void engine.controller.cancel('review')
      setRunning(false)
      setMessage('Paused while app is hidden. Resume from this tab when visible.')
    }
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [engine.controller])

  async function persist(progress: ReviewReport, sequence: number) {
    if (runId.current !== sequence) return
    reportRef.current = progress
    setReport(progress)
    try { await putReview(game.id, progress); setStorageWarning('') }
    catch { setStorageWarning('Review storage unavailable; completed progress will not survive a reload. Export your game for backup.') }
  }

  async function start() {
    if (running || abortRef.current) return
    const sequence = ++runId.current
    const abort = new AbortController()
    abortRef.current = abort
    setRunning(true)
    engine.controller.setReviewActive(true)
    setMessage('Initializing the review engine…')
    preparing.current = true
    try {
      const descriptor = await engine.ensureReady()
      // Allow React to commit the descriptor and constrained options before capturing identity.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (abort.signal.aborted || runId.current !== sequence) return
      const ready = latestEngine.current
      const supportsMultiPv = descriptor.options.some(option => option.name.toLowerCase() === 'multipv' && option.type === 'spin' && (option.min ?? 1) <= 2 && (option.max ?? 2) >= 2)
      const reviewSettings = { ...ready.settings, multiPv: supportsMultiPv ? 2 : undefined, strength: { kind: 'full' as const } }
      const requested = reviewSignature(game, descriptor, ready.provider, reviewSettings, depth, timeMs)
      // Initializing our own engine changes the signature; only an unrelated change cancels this run.
      activeSignatureKey.current = JSON.stringify({ ...requested, revision: 0 })
      const currentKey = JSON.stringify({ ...reviewSignature(latestGame.current, descriptor, ready.provider, reviewSettings, depth, timeMs), revision: 0 })
      if (currentKey !== activeSignatureKey.current) throw new ReviewInterrupted()
      preparing.current = false
      const prior = matchesReview(reportRef.current ?? undefined, requested) ? reportRef.current! : await getReview<ReviewReport>(game.id).catch(() => undefined)
      if (abort.signal.aborted || runId.current !== sequence) return
      const initial = prepareReview(game, requested, prior)
      await persist(initial, sequence)
      setMessage('Reviewing mainline positions…')
      const completed = await runReview(game, initial, (request, signal) => engine.controller.search('review', request, signal), abort.signal, progress => persist(progress, sequence))
      if (runId.current === sequence && !abort.signal.aborted) setMessage(`Review complete at up to depth ${Math.max(0, ...Object.values(completed.moves).map(move => move.actualDepth))}.`)
    } catch (error) {
      if (runId.current === sequence && !(abort.signal.aborted || error instanceof ReviewInterrupted)) setMessage(error instanceof Error ? error.message : 'Engine review failed. Resume to retry.')
      else if (runId.current === sequence && !abort.signal.aborted) setMessage('Review interrupted. Resume to retry the current move.')
    } finally {
      preparing.current = false
      if (runId.current === sequence) { abortRef.current = null; setRunning(false); engine.controller.setReviewActive(false) }
    }
  }

  function pause() {
    abortRef.current?.abort()
    abortRef.current = null
    engine.controller.setReviewActive(false)
    void engine.controller.cancel('review')
    setRunning(false)
    setMessage('Paused. Completed moves are retained; Resume retries the current move.')
  }

  function cancel() {
    pause()
    const cancelled: ReviewReport | null = reportRef.current && { ...reportRef.current, status: 'cancelled' }
    reportRef.current = cancelled
    setReport(cancelled)
    if (cancelled) void putReview(game.id, cancelled).catch(() => setStorageWarning('Review storage unavailable; export your game for backup.'))
    setMessage('Review cancelled. Start begins a fresh review.')
  }

  const valid = !!(signature && matchesReview(report ?? undefined, signature))
  const current = valid ? report! : null
  const summary = current ? reviewSummary(current, game) : null
  const completed = nodeIds.filter(id => current?.moves[id]).length
  const activeMove = current?.moves[game.currentId]
  const criticalIds = nodeIds.filter(id => current?.moves[id] && critical[current.moves[id].label])
  const criticalIndex = criticalIds.indexOf(game.currentId)
  const graph = nodeIds.map((id, index) => {
    const score = current?.moves[id]?.whiteScore
    if (!score) return null
    const cp = score.kind === 'mate' ? Math.sign(score.value || (current?.moves[id]?.side === 'white' ? 1 : -1)) * 1000 : score.value
    return { id, x: 20 + index * (560 / Math.max(1, nodeIds.length - 1)), y: 80 - 61 * Math.tanh(cp / 380), label: `${moveName(game, id)}: ${scoreText(score)} from White’s perspective` }
  })
  const paths: string[] = []
  let path = ''
  for (const point of graph) {
    if (!point) { if (path) paths.push(path); path = ''; continue }
    path += `${path ? ' L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`
  }
  if (path) paths.push(path)
  const actualDepths = nodeIds.map(id => current?.moves[id]?.actualDepth ?? 0).filter(value => value > 0)
  const depthRange = actualDepths.length ? `${Math.min(...actualDepths)}${Math.min(...actualDepths) === Math.max(...actualDepths) ? '' : `–${Math.max(...actualDepths)}`}` : '—'
  const isComplete = current?.status === 'completed'
  const selectedEvidence = activeMove ? <article className={`review-evidence review-${activeMove.label.toLowerCase()}`} aria-label={`Review of ${moveName(game, game.currentId)}`}>
    <div className="review-evidence-heading"><div><span className="review-kicker">SELECTED MOVE · {activeMove.side.toUpperCase()}</span><h3>{moveName(game, game.currentId)}</h3></div><span className={`review-label review-${activeMove.label.toLowerCase()}`}><MoveQualityBadge label={activeMove.label} decorative /> {activeMove.label}</span></div>
    <p>{activeMove.explanation}</p>
    <div className="review-evidence-metrics"><span>Move score (White) <strong>{scoreText(activeMove.whiteScore)}</strong></span><span>Common depth <strong>{activeMove.actualDepth || '—'}</strong></span><span>Best / played depth <strong>{activeMove.bestDepth ?? '—'} / {activeMove.playedDepth ?? '—'}</strong></span></div>
    {activeMove.bestSan?.length ? <div className="review-continuation"><span className="review-kicker">BEST ENGINE CONTINUATION</span><p>{activeMove.bestSan.map((san, index) => <span key={index}>{index > 0 && <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />}<span>{san}</span></span>)}</p></div> : null}
    {activeMove.label === 'Brilliant' && <small>Engine-backed sacrifice heuristic; not proof of strategic brilliance.</small>}
    {activeMove.label === 'Uncertain' && depth < 30 && <button type="button" className="review-deepen" disabled={running} onClick={() => { setDepth(Math.min(30, depth + 2)); setMessage('Depth increased. Start review to re-evaluate all moves under one compatible signature.') }}>Deepen uncertain moves · restart at depth {Math.min(30, depth + 2)}</button>}
  </article> : <div className="review-empty-selection"><FontAwesomeIcon icon={faChessBoard} aria-hidden="true" /><p>{current ? 'Select a reviewed move on the graph or in Moves to see its evidence.' : 'Move-by-move evidence appears here as the review progresses.'}</p></div>

  return <section className="review-panel" aria-label="Automated game review">
    <header className="review-heading"><div><span className="eyebrow">ENGINE-BACKED REVIEW</span><h2>Game review</h2></div><p>Transparent move quality from exact, completed engine scores at a common depth. ChessIn quality is our own measure, not Chess.com accuracy or Elo.</p></header>
    <div className="review-run">
      <div className="review-run-top"><div><span className="review-kicker">MAINLINE COVERAGE</span><strong>{completed} <span>/ {nodeIds.length} moves</span></strong></div><span className={`review-run-state ${running ? 'is-running' : isComplete ? 'is-complete' : ''}`}>{running ? 'Reviewing' : isComplete ? 'Complete' : current?.status === 'cancelled' ? 'Cancelled' : current ? 'Paused' : 'Not started'}</span></div>
      <div className="review-progress" role="progressbar" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={nodeIds.length} aria-label="Reviewed moves"><div style={{ width: `${nodeIds.length ? 100 * completed / nodeIds.length : 0}%` }} /></div>
      <div className="review-run-meta"><span>Actual depth {depthRange}</span><span>Target depth {depth} · up to {(timeMs / 1000).toLocaleString()}s per search</span></div>
      <div className="review-actions">
        {running ? <button type="button" className="review-main-action" onClick={pause}><FontAwesomeIcon icon={faPause} aria-hidden="true" /> Pause review</button>
          : isComplete ? <span className="review-complete-action"><FontAwesomeIcon icon={faCircleCheck} aria-hidden="true" /> Review complete</span>
          : <button type="button" className="review-main-action primary-button" disabled={!nodeIds.length} onClick={() => void start()}><FontAwesomeIcon icon={completed && current?.status !== 'cancelled' ? faClockRotateLeft : faPlay} aria-hidden="true" /> {completed && current?.status !== 'cancelled' ? 'Resume review' : 'Start review'}</button>}
        {(running || (current && current.status !== 'completed' && current.status !== 'cancelled')) && <button type="button" className="review-cancel" onClick={cancel}>Cancel</button>}
      </div>
      <details className="review-advanced"><summary>Advanced review settings <span>Depth {depth} · {timeMs} ms</span></summary><div className="review-options"><label>Target depth <input type="number" min={10} max={30} value={depth} disabled={running} onChange={event => setDepth(Math.max(10, Math.min(30, Number(event.target.value) || 10)))} /></label><label>Time per search (ms) <input type="number" min={250} max={30000} step={250} value={timeMs} disabled={running} onChange={event => setTimeMs(Math.max(250, Math.min(30000, Number(event.target.value) || 250)))} /></label></div><small>Changing either setting starts a new compatible review; previously graded moves are not mixed with new results.</small></details>
      <p className="review-message" role="status">{message}</p>{storageWarning && <p role="alert" className="review-storage-warning">{storageWarning}</p>}
    </div>
    <div className="review-tabs" role="tablist" aria-label="Review views" onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'moves' : tab === 'overview' ? 'moves' : 'overview'; setTab(next); document.getElementById(`${tabsId}-${next}-tab`)?.focus() }}>
      {(['overview', 'moves'] as const).map(view => <button key={view} type="button" role="tab" id={`${tabsId}-${view}-tab`} aria-controls={`${tabsId}-${view}-panel`} aria-selected={tab === view} tabIndex={tab === view ? 0 : -1} onClick={() => setTab(view)}><FontAwesomeIcon icon={view === 'overview' ? faChartLine : faChessBoard} aria-hidden="true" />{view === 'overview' ? 'Overview' : 'Moves'}</button>)}
    </div>
    <div className="review-tab-content" role="tabpanel" id={`${tabsId}-overview-panel`} aria-labelledby={`${tabsId}-overview-tab`} tabIndex={0} hidden={tab !== 'overview'}>
      {summary ? <>
        <div className="review-quality">{(['white', 'black'] as const).map(side => <div className={`review-quality-card review-${side}`} key={side}><span className="review-kicker">{side.toUpperCase()} · CHESSIN QUALITY</span><strong className="review-player">{game.headers[side === 'white' ? 'White' : 'Black']?.trim() || (side === 'white' ? 'White' : 'Black')}</strong><div className="review-quality-value">{summary[side].quality === null ? '—' : summary[side].quality}<span>{summary[side].quality === null ? 'No graded moves yet' : 'out of 100'}</span></div><small>{summary[side].graded} / {summary[side].total} non-forced moves graded{summary[side].graded < summary[side].total ? ' · partial coverage' : ''}</small></div>)}</div>
        <div className="review-counts"><div className="review-section-heading"><FontAwesomeIcon icon={faTrophy} aria-hidden="true" /><h3>Move classifications</h3></div><div className="review-counts-scroll"><table><thead><tr><th scope="col">White</th><th scope="col">Classification</th><th scope="col">Black</th></tr></thead><tbody>{classifications.map(label => <tr key={label}><td>{summary.white.counts[label] ?? 0}</td><th scope="row"><span className={`review-label review-${label.toLowerCase()}`}><MoveQualityBadge label={label} decorative /> {label}</span></th><td>{summary.black.counts[label] ?? 0}</td></tr>)}</tbody></table></div></div>
      </> : <div className="review-empty"><FontAwesomeIcon icon={faChartLine} aria-hidden="true" /><strong>{nodeIds.length ? 'Your review starts here' : 'No moves to review yet'}</strong><p>{nodeIds.length ? 'Start a review to see ChessIn quality, classification counts and move-by-move evidence. Scores remain unavailable until an exact engine review completes.' : 'Add mainline moves to this game, then start a review.'}</p></div>}
      <div className="review-graph"><div className="review-section-heading"><FontAwesomeIcon icon={faChartLine} aria-hidden="true" /><div><h3>Evaluation graph</h3><small>White’s perspective · select a point to inspect a move</small></div></div>{graph.some(Boolean) ? <svg viewBox="0 0 600 160" role="group" aria-label="White-perspective evaluation graph; select a move with its point"><line x1="20" y1="80" x2="580" y2="80" stroke="#84917d" strokeDasharray="3 5" /><text x="20" y="69" fill="#b4bbad" fontSize="11">Equal</text>{paths.map((d, i) => <path key={i} d={d} fill="none" stroke="#8fbd57" strokeWidth="2.5" />)}{graph.filter((point): point is NonNullable<typeof point> => !!point).map(point => <g key={point.id} role="button" tabIndex={0} aria-label={`Select ${point.label}`} onClick={() => onSelect(point.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.id) } }}><circle cx={point.x} cy={point.y} r="12" fill="transparent" /><circle className="review-graph-dot" cx={point.x} cy={point.y} r={game.currentId === point.id ? 7 : 5} fill={game.currentId === point.id ? '#28b8bd' : '#8fbd57'} stroke="#161815" strokeWidth="2" /></g>)}</svg> : <p className="review-graph-empty">No exact evaluations available yet. Completed exact-score moves appear here.</p>}</div>
      {selectedEvidence}
      {criticalIds.length > 0 && <div className="review-critical"><div className="review-section-heading"><FontAwesomeIcon icon={faClockRotateLeft} aria-hidden="true" /><h3>Critical moves</h3></div><div><button type="button" onClick={() => onSelect(criticalIds[Math.max(0, criticalIndex - 1)])}>Previous critical</button><button type="button" onClick={() => onSelect(criticalIds[criticalIndex + 1] ?? criticalIds[0])}>Next critical</button></div></div>}
      <p className="review-method">ChessIn quality averages graded, non-forced move losses; missing grades are excluded. Move scores evaluate the played continuation from its parent position, so mate distances begin before that move. Brilliant is an engine-backed sacrifice heuristic, not proof of strategic brilliance.</p>
    </div>
    <div className="review-tab-content" role="tabpanel" id={`${tabsId}-moves-panel`} aria-labelledby={`${tabsId}-moves-tab`} tabIndex={0} hidden={tab !== 'moves'}>
      <div className="review-section-heading"><FontAwesomeIcon icon={faChessBoard} aria-hidden="true" /><div><h3>Mainline moves</h3><small>{completed} reviewed · select a move to inspect its evidence</small></div></div>
      {nodeIds.length ? <ol className="review-moves">{nodeIds.map(id => { const move = current?.moves[id]; return <li key={id}><button type="button" className={id === game.currentId ? 'selected' : ''} aria-current={id === game.currentId ? 'step' : undefined} onClick={() => onSelect(id)}><span>{moveName(game, id)}</span><strong className={`review-label review-${move?.label.toLowerCase() || 'pending'}`}>{move ? <><MoveQualityBadge label={move.label} decorative /> {move.label}</> : 'Pending'}</strong></button>{move && <small>{move.explanation}</small>}</li> })}</ol> : <div className="review-empty"><p>Add mainline moves to inspect them here.</p></div>}
      {selectedEvidence}
    </div>
  </section>
}

export default ReviewPanel
