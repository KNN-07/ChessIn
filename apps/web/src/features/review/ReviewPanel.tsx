import { useEffect, useMemo, useRef, useState } from 'react'
import type { GameDocument } from '@chessin/core/game'
import type { EngineScore } from '@chessin/core/engine'
import { mainlineNodes, matchesReview, reviewSignature, reviewSummary, type ReviewReport, type ReviewMove } from '@chessin/core/review'
import { useEngine } from '../../engine/EngineContext'
import { getReview, putReview } from '../../storage/db'
import { prepareReview, ReviewInterrupted, runReview } from './review-runner'
import './ReviewPanel.css'

export interface ReviewPanelProps {
  game: GameDocument
  onSelect: (nodeId: string) => void
  onGrades?: (grades: Record<string, { label: string }>) => void
}

const symbols: Record<string, string> = { Brilliant: '!!', Great: '!', Best: '✓', Excellent: '✓', Good: '·', Inaccuracy: '?!', Mistake: '?', Blunder: '??', Forced: '↳', Uncertain: '…' }
const critical: Record<string, true> = { Brilliant: true, Great: true, Inaccuracy: true, Mistake: true, Blunder: true, Uncertain: true }

function scoreText(score?: EngineScore): string {
  if (!score) return '—'
  const bound = score.bound === 'lower' ? '≥' : score.bound === 'upper' ? '≤' : ''
  if (score.kind === 'mate') return `${bound}${score.value < 0 ? '−' : ''}M${Math.abs(score.value)}`
  return `${bound}${score.value >= 0 ? '+' : '−'}${(Math.abs(score.value) / 100).toFixed(2)}`
}

export function ReviewPanel({ game, onSelect, onGrades }: ReviewPanelProps) {
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
    const grades = Object.fromEntries(Object.entries(signature && matchesReview(report ?? undefined, signature) ? report!.moves : {}).map(([id, move]) => [id, { label: move.label }]))
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
    return { id, x: 20 + index * (560 / Math.max(1, nodeIds.length - 1)), y: 80 - 61 * Math.tanh(cp / 380), label: `${index + 1}. ${game.nodes[id].san}: ${scoreText(score)} White perspective` }
  })
  const paths: string[] = []
  let path = ''
  for (const point of graph) {
    if (!point) { if (path) paths.push(path); path = ''; continue }
    path += `${path ? ' L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`
  }
  if (path) paths.push(path)

  return <section className="review-panel" aria-label="Automated game review">
    <header><span className="eyebrow">ENGINE-BACKED REVIEW</span><h2>Game review</h2><p>Grades compare exact, completed scores at the same depth from the mover’s perspective. No Elo or Chess.com accuracy is claimed.</p></header>
    <div className="review-options"><label>Target depth <input type="number" min={10} max={30} value={depth} disabled={running} onChange={event => setDepth(Math.max(10, Math.min(30, Number(event.target.value) || 10)))} /></label><label>Time per search (ms) <input type="number" min={250} max={30000} step={250} value={timeMs} disabled={running} onChange={event => setTimeMs(Math.max(250, Math.min(30000, Number(event.target.value) || 250)))} /></label></div>
    <div className="review-actions"><button type="button" className="primary-button" disabled={running || !nodeIds.length || current?.status === 'completed'} onClick={() => void start()}>{completed && current?.status !== 'cancelled' ? 'Resume review' : 'Start review'}</button>{running && <button type="button" onClick={pause}>Pause</button>}{(running || (current && current.status !== 'completed' && current.status !== 'cancelled')) && <button type="button" onClick={cancel}>Cancel</button>}</div>
    <p role="status">{message}</p>{storageWarning && <p role="alert" className="review-storage-warning">{storageWarning}</p>}
    <div className="review-progress" role="progressbar" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={nodeIds.length} aria-label="Reviewed moves"><div style={{ width: `${nodeIds.length ? 100 * completed / nodeIds.length : 0}%` }} /></div><small>{completed} of {nodeIds.length} mainline moves reviewed · {current?.status ?? 'not started'}</small>
    {summary && <div className="review-quality">{(['white', 'black'] as const).map(side => <div key={side}><strong>{side === 'white' ? 'White' : 'Black'} · ChessIn quality {summary[side].quality ?? '—'}</strong><small>{summary[side].graded}/{summary[side].total} non-forced moves graded (partial coverage when incomplete)</small><span>{Object.entries(summary[side].counts).map(([label, count]) => `${label} ${count}`).join(' · ') || 'No grades yet'}</span></div>)}</div>}
    <div className="review-graph"><h3>Evaluation · White’s perspective</h3>{graph.some(Boolean) ? <svg viewBox="0 0 600 160" role="group" aria-label="White-perspective evaluation graph; select a move with its point"><line x1="20" y1="80" x2="580" y2="80" stroke="#888" strokeDasharray="3 5" />{paths.map((d, i) => <path key={i} d={d} fill="none" stroke="#8fbd57" strokeWidth="2" />)}{graph.filter((point): point is NonNullable<typeof point> => !!point).map(point => <circle key={point.id} cx={point.x} cy={point.y} r={game.currentId === point.id ? 7 : 5} fill={game.currentId === point.id ? '#28b8bd' : '#8fbd57'} stroke="#161815" strokeWidth="2" role="button" tabIndex={0} aria-label={`Select ${point.label}`} onClick={() => onSelect(point.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.id) } }} />)}</svg> : <p>No exact evaluations available yet.</p>}</div>
    {activeMove && <article className={`review-evidence review-${activeMove.label.toLowerCase()}`}><strong>{activeMove.san} · {symbols[activeMove.label]} {activeMove.label}</strong><p>{activeMove.explanation}</p><small>Actual common depth {activeMove.actualDepth || '—'} · best {activeMove.bestDepth ?? '—'} · played {activeMove.playedDepth ?? '—'} · White {scoreText(activeMove.whiteScore)}</small>{activeMove.bestSan?.length ? <p>Engine continuation: {activeMove.bestSan.join(' → ')}</p> : null}{activeMove.label === 'Brilliant' && <small>Engine-backed sacrifice heuristic; not proof of strategic brilliance.</small>}</article>}
    {criticalIds.length > 0 && <div className="review-critical"><h3>Critical moves</h3><div><button type="button" onClick={() => onSelect(criticalIds[Math.max(0, criticalIndex - 1)])}>Previous critical</button><button type="button" onClick={() => onSelect(criticalIds[criticalIndex + 1] ?? criticalIds[0])}>Next critical</button></div></div>}
    {current && <ol className="review-moves">{nodeIds.map((id, index) => { const move: ReviewMove | undefined = current.moves[id]; return <li key={id}><button type="button" className={id === game.currentId ? 'selected' : ''} onClick={() => onSelect(id)}><span>{index + 1}. {game.nodes[id].san}</span><strong className={`review-label review-${move?.label.toLowerCase() || 'pending'}`}>{move ? `${symbols[move.label]} ${move.label}` : 'Pending'}</strong></button>{move && <small>{move.explanation}</small>}</li> })}</ol>}
    {current && current.moves[game.currentId]?.label === 'Uncertain' && depth < 30 && <button type="button" disabled={running} onClick={() => { setDepth(Math.min(30, depth + 2)); setMessage('Depth increased. Start review to re-evaluate all moves under one compatible signature.') }}>Deepen uncertain moves · restart at depth {Math.min(30, depth + 2)}</button>}
  </section>
}

export default ReviewPanel
