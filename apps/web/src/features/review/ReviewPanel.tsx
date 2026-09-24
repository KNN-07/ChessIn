import { useEffect, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPause, faPlay } from '@fortawesome/free-solid-svg-icons'
import type { GameDocument } from '@chessin/core/game'
import { mainlineNodes, matchesReview, reviewSignature, type ReviewReport, type ReviewMove } from '@chessin/core/review'
import { useEngine } from '../../engine/EngineContext'
import { getReview, putReview } from '../../storage/db'
import { prepareReview, ReviewInterrupted, runReview } from './review-runner'
import './ReviewPanel.css'

export interface ReviewPanelProps {
  game: GameDocument
  onGrades?: (grades: Record<string, ReviewMove>) => void
  onRunningChange?: (running: boolean) => void
}

export function ReviewPanel({ game, onGrades, onRunningChange }: ReviewPanelProps) {
  const engine = useEngine()
  const [depth, setDepth] = useState(16)
  const [timeMs, setTimeMs] = useState(3000)
  const [report, setReport] = useState<ReviewReport | null>(null)
  const reportRef = useRef<ReviewReport | null>(null)
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [message, setMessage] = useState('')
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
    setMessage('')
    setPaused(false)
    if (!signature) return
    void getReview<ReviewReport>(game.id).then(saved => {
      if (sequence === runId.current && matchesReview(saved, signature)) {
        reportRef.current = saved!
        setReport(saved!)
        setMessage('')
        setPaused(saved!.status === 'paused')
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
  useEffect(() => { onRunningChange?.(running) }, [running, onRunningChange])
  useEffect(() => () => onRunningChange?.(false), [onRunningChange])

  useEffect(() => {
    function visibility() {
      if (!document.hidden || !abortRef.current) return
      ++runId.current
      abortRef.current.abort()
      abortRef.current = null
      preparing.current = false
      engine.controller.setReviewActive(false)
      void engine.controller.cancel('review')
      setRunning(false)
      setPaused(true)
      setMessage('Paused while app was hidden. Resume when ready.')
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
    setPaused(false)
    engine.controller.setReviewActive(true)
    setMessage('')
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
      await runReview(game, initial, (request, signal) => engine.controller.search('review', request, signal), abort.signal, progress => persist(progress, sequence))
      if (runId.current === sequence && !abort.signal.aborted) setMessage('')
    } catch (error) {
      if (runId.current === sequence && !(abort.signal.aborted || error instanceof ReviewInterrupted)) setMessage(error instanceof Error ? error.message : 'Engine review failed. Resume to retry.')
      else if (runId.current === sequence && !abort.signal.aborted) setMessage('Review interrupted. Resume to retry the current move.')
    } finally {
      if (runId.current === sequence) {
        preparing.current = false
        abortRef.current = null
        setRunning(false)
        engine.controller.setReviewActive(false)
      }
    }
  }

  function pause() {
    ++runId.current
    abortRef.current?.abort()
    abortRef.current = null
    preparing.current = false
    engine.controller.setReviewActive(false)
    void engine.controller.cancel('review')
    setRunning(false)
    setPaused(true)
    setMessage('')
  }

  const valid = !!(signature && matchesReview(report ?? undefined, signature))
  const current = valid ? report! : null
  const completed = nodeIds.filter(id => current?.moves[id]).length
  const isComplete = current?.status === 'completed'
  const canResume = current?.status !== 'cancelled' && (paused || completed > 0)

  return <section className="review-panel" aria-label="Game review controls">
    <div className="review-run">
      <button type="button" className="review-main-action" disabled={!running && (isComplete || !nodeIds.length)} onClick={running ? pause : () => void start()}>
        <FontAwesomeIcon icon={running ? faPause : faPlay} aria-hidden="true" />
        {running ? 'Pause analysis' : isComplete ? 'Analysis complete' : canResume ? 'Resume analysis' : 'Analyze game'}
      </button>
      <div className="review-run-top"><strong>{completed} / {nodeIds.length} moves</strong><span className={`review-run-state ${running ? 'is-running' : isComplete ? 'is-complete' : ''}`} role="status">{running ? 'Analyzing' : isComplete ? 'Complete' : paused || (current && current.status !== 'cancelled') ? 'Paused' : 'Ready'}</span></div>
      {nodeIds.length > 0 && <div className="review-progress" role="progressbar" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={nodeIds.length} aria-label="Reviewed moves"><div style={{ width: `${100 * completed / nodeIds.length}%` }} /></div>}
      <details className="review-advanced"><summary>Analysis settings &amp; method</summary>
        <div className="review-options">
          <label>Target depth <input type="number" min={10} max={30} value={depth} disabled={running} onChange={event => setDepth(Math.max(10, Math.min(30, Number(event.target.value) || 10)))} /></label>
          <label>Time per search (ms) <input type="number" min={250} max={30000} step={250} value={timeMs} disabled={running} onChange={event => setTimeMs(Math.max(250, Math.min(30000, Number(event.target.value) || 250)))} /></label>
        </div>
        <small>Changing settings starts a new review; grades from different settings are never mixed. Only exact, completed engine scores at a common depth are used. ChessIn quality is not Chess.com accuracy or Elo; brilliant moves use a sacrifice heuristic, not proof of strategic brilliance.</small>
      </details>
      {message && <p className="review-message" role="alert">{message}</p>}
      {storageWarning && <p className="review-storage-warning" role="alert">{storageWarning}</p>}
    </div>
  </section>
}

export default ReviewPanel
