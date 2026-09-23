import { useEffect, useMemo, useRef, useState } from 'react'
import { getPosition, reconstruct, type GameDocument } from '@chessin/core/game'
import { exportPgn } from '@chessin/core/pgn'
import type { EngineDescriptor, EngineSettings, SearchLimit } from '@chessin/core/engine'
import { AnalysisBoard } from '../../components/AnalysisBoard'
import { useEngine } from '../../engine/EngineContext'
import { EngineSettingsPanel } from '../../engine/EngineSettingsPanel'
import { flushSaves, loadGame, saveGame } from '../../storage/db'
import { PlaySession, readPlayState, type Side } from './play-session'
import './play.css'

export interface PlayPageProps {
  game?: GameDocument
  onChange: (game: GameDocument) => void
  onReview: (game: GameDocument) => void
  onActiveChange?: (active: boolean) => void
  /** The parent calls this before leaving. It must await the returned persistence promise. */
  onSuspendReady?: (suspend: () => Promise<void>) => void
}

type Preset = 'untimed' | '3+2' | '5+0' | '10+0' | 'custom'
const presets: Record<Exclude<Preset, 'custom'>, [number | null, number]> = {
  untimed: [null, 0], '3+2': [3, 2], '5+0': [5, 0], '10+0': [10, 0],
}

export function PlayPage({ game, onChange, onReview, onActiveChange, onSuspendReady }: PlayPageProps) {
  const engine = useEngine()
  const [session, setSession] = useState<PlaySession | null>(() => game && readPlayState(game) ? PlaySession.restore(game) : null)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [view, setView] = useState<GameDocument | null>(() => session?.game ?? null)
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | 'unsaved'>(game ? 'unsaved' : 'saved')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preset, setPreset] = useState<Preset>('3+2')
  const [minutes, setMinutes] = useState(3)
  const [increment, setIncrement] = useState(2)
  const [color, setColor] = useState<'white' | 'black' | 'random'>('white')
  const [strength, setStrength] = useState<'skill' | 'elo' | 'full'>('skill')
  const [skill, setSkill] = useState(10)
  const [elo, setElo] = useState<number | null>(null)
  const [moveText, setMoveText] = useState('')
  const [displayTick, setDisplayTick] = useState(0)
  const saveTail = useRef<Promise<void>>(Promise.resolve())

  function persist(): Promise<void> {
    const current = sessionRef.current
    if (!current) return Promise.resolve()
    setView(current.game)
    onChangeRef.current(current.game)
    setSaveStatus('saving')
    const operation = saveTail.current.catch(() => undefined).then(async () => {
      const latest = sessionRef.current
      if (!latest) return
      const submitted = latest.game
      try {
        const saved = await saveGame(submitted)
        const adopted = latest.adoptSaved(saved, submitted)
        if (adopted !== submitted) { setView(adopted); onChangeRef.current(adopted) }
        if (latest.game.id === saved.id && latest.game.revision === saved.revision) setSaveStatus('saved')
      } catch (failure) {
        setSaveStatus('unsaved')
        setError(failure instanceof Error ? failure.message : 'Could not save game. Export your PGN now.')
        throw failure
      }
    })
    saveTail.current = operation
    return operation
  }

  // Reopen a different saved game without ever resuming its clocks implicitly.
  useEffect(() => {
    if (game && game.id !== sessionRef.current?.game.id && readPlayState(game)) {
      const restored = PlaySession.restore(game)
      sessionRef.current = restored
      setSession(restored)
      setView(restored.game)
      if (restored.game !== game) void persist().catch(() => undefined)
    }
  }, [game?.id])
  useEffect(() => {
    if (session?.game !== game && session?.game.id === game?.id && game && readPlayState(game)?.status === 'active') {
      void persist().catch(() => undefined)
    }
  }, [])
  useEffect(() => {
    if (!game || !readPlayState(game)) return
    let alive = true
    void loadGame(game.id).then(persisted => {
      const activeSession = sessionRef.current
      if (alive && persisted && activeSession && persisted.id === activeSession.game.id &&
          persisted.revision === activeSession.game.revision) setSaveStatus('saved')
    }).catch(() => undefined)
    return () => { alive = false }
  }, [game?.id])

  const state = view ? readPlayState(view) : null
  const active = state?.status === 'active'
  useEffect(() => {
    engine.controller.setPlayActive(active)
    return () => { engine.controller.cancel('play'); engine.controller.setPlayActive(false) }
  }, [active, engine.controller])
  useEffect(() => { onActiveChange?.(active) }, [active, onActiveChange])
  useEffect(() => {
    onSuspendReady?.(async () => {
      const current = sessionRef.current
      if (current?.isActive) {
        engine.controller.cancel('play')
        current.suspend()
        await persist()
      }
      await saveTail.current
      await flushSaves()
    })
  }, [onSuspendReady, engine.controller])
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      const current = sessionRef.current
      setDisplayTick(value => value + 1)
      if (current?.tick()) {
        engine.controller.cancel('play')
        void persist().catch(() => undefined)
      }
    }, 100)
    return () => window.clearInterval(timer)
  }, [active, engine.controller])

  useEffect(() => {
    if (!view || !active || !sessionRef.current || sessionRef.current.turn === state?.humanColor) return
    const current = sessionRef.current
    const revision = current.game.revision
    const requestId = crypto.randomUUID()
    const controller = new AbortController()
    const limit: SearchLimit = state!.initialMs === null ? { kind: 'bounded', moveTimeMs: 1000 } : {
      kind: 'clock', whiteMs: Math.max(0, Math.floor(current.remaining('w')!)), blackMs: Math.max(0, Math.floor(current.remaining('b')!)),
      whiteIncrementMs: state!.incrementMs, blackIncrementMs: state!.incrementMs,
    }
    const request = { requestId, engineId: state!.engineId, position: getPosition(current.game),
      settings: state!.settings, limit }
    engine.controller.newGame(current.game.id)
    let receivedMove = false
    void (async () => {
      try {
        for await (const event of engine.controller.search('play', request, controller.signal)) {
          if (controller.signal.aborted || sessionRef.current !== current || !current.isActive || current.game.revision !== revision) break
          if (event.type === 'bestmove') {
            if (!event.move) throw new Error('Engine did not return a legal move')
            current.move(event.move, current.turn, revision)
            receivedMove = true
            void persist().catch(() => undefined)
          } else if (event.type === 'error') throw new Error(event.message)
          else if (event.type === 'done' && !receivedMove) throw new Error('Engine search ended without a move')
        }
        if (!controller.signal.aborted && current.isActive && current.game.revision === revision && !receivedMove)
          throw new Error('Engine disconnected before returning a move')
      } catch (failure) {
        if (controller.signal.aborted) return
        if (!current.isActive) { void persist().catch(() => undefined); return }
        engine.controller.cancel('play')
        current.suspend(true)
        setError(failure instanceof Error ? failure.message : 'Engine interrupted. Reconnect or resume explicitly.')
        void persist().catch(() => undefined)
      }
    })()
    return () => controller.abort()
  }, [view?.id, view?.revision, active, engine.controller])

  function supported(descriptor: EngineDescriptor, option: string) {
    return descriptor.options.find(item => item.name.toLowerCase() === option.toLowerCase())
  }
  async function start() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const [chosenMinutes, chosenIncrement] = preset === 'custom' ? [minutes, increment] : presets[preset]
      if (chosenMinutes !== null && (!Number.isInteger(chosenMinutes) || chosenMinutes < 1 || chosenMinutes > 180)) throw new Error('Choose 1–180 minutes')
      if (!Number.isInteger(chosenIncrement) || chosenIncrement < 0 || chosenIncrement > 60) throw new Error('Choose 0–60 seconds increment')
      const selectedProvider = engine.provider
      const selectedProfile = engine.profile
      const descriptor = await engine.ensureReady() // No clock starts during download/initialization.
      if (engine.provider !== selectedProvider || engine.profile !== selectedProfile) throw new Error('Engine changed before the game started')
      const skillOption = supported(descriptor, 'Skill Level')
      const hasSkill = skillOption?.type === 'spin'
      const eloOption = supported(descriptor, 'UCI_Elo')
      const hasElo = eloOption?.type === 'spin' && supported(descriptor, 'UCI_LimitStrength')?.type === 'check'
      const selectedStrength: EngineSettings['strength'] = strength === 'elo' && hasElo
        ? { kind: 'elo', value: Math.max(eloOption!.min ?? 0, Math.min(eloOption!.max ?? Number.MAX_SAFE_INTEGER, elo ?? Number(eloOption!.default ?? eloOption!.min ?? 0))) }
        : strength === 'skill' && hasSkill ? { kind: 'skill',
          value: Math.max(skillOption!.min ?? 0, Math.min(skillOption!.max ?? 20, skill)) } : { kind: 'full' }
      if (strength === 'elo' && !hasElo || strength === 'skill' && !hasSkill) throw new Error('Selected engine does not support that strength control')
      const humanColor: Side = color === 'random' ? (crypto.getRandomValues(new Uint8Array(1))[0] < 128 ? 'w' : 'b') : color === 'white' ? 'w' : 'b'
      const control = (name: string, value: number | undefined) => {
        const option = supported(descriptor, name)
        if (option?.type !== 'spin' || value === undefined) return undefined
        return Math.max(option.min ?? value, Math.min(option.max ?? value, value))
      }
      const created = PlaySession.begin({ humanColor, provider: selectedProvider, profile: selectedProfile,
        engineId: descriptor.id, engineName: descriptor.name, engineVersion: descriptor.buildVersion,
        settings: {
          threads: control('Threads', selectedProvider === 'local' && selectedProfile.endsWith('single') ? 1 : engine.settings.threads),
          hashMb: control('Hash', engine.settings.hashMb),
          multiPv: control('MultiPV', 1),
          strength: selectedStrength,
        },
        initialMs: chosenMinutes === null ? null : chosenMinutes * 60_000, incrementMs: chosenIncrement * 1000 })
      sessionRef.current = created
      setSession(created); setView(created.game)
      engine.controller.setPlayActive(true)
      await persist()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not start engine') }
    finally { setBusy(false) }
  }

  async function resume() {
    const current = sessionRef.current
    if (!current || busy) return
    setBusy(true); setError('')
    try {
      if (engine.provider !== current.state.provider || engine.profile !== current.state.profile) throw new Error('Select the same provider and engine profile to resume this game')
      const descriptor = await engine.ensureReady()
      if (descriptor.id !== current.state.engineId || descriptor.buildVersion !== current.state.engineVersion) throw new Error('Reconnect to the same engine and version to resume')
      engine.controller.newGame(current.game.id)
      current.resume()
      engine.controller.setPlayActive(true)
      await persist()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not resume engine') }
    finally { setBusy(false) }
  }

  function humanMove(uci: string) {
    const current = sessionRef.current
    if (!current || !current.isActive || current.turn !== current.state.humanColor) return
    try { current.move(uci, current.turn); void persist().catch(() => undefined) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Illegal or late move'); if (!current.isActive) void persist().catch(() => undefined) }
  }
  function endGame(resign: boolean) {
    const current = sessionRef.current
    if (!current || !window.confirm(resign ? 'Resign this game?' : 'Abandon this game?')) return
    engine.controller.cancel('play')
    if (resign) current.resign(); else current.abandon()
    void persist().catch(() => undefined)
  }
  async function openReview() {
    const current = sessionRef.current
    if (!current || current.state.status !== 'finished') return
    try { await saveTail.current; await flushSaves(); onReview(current.game) }
    catch { setError('Save failed. Export the PGN before leaving.') }
  }
  function exportGame() {
    const current = sessionRef.current
    if (!current) return
    const url = URL.createObjectURL(new Blob([exportPgn(current.game)], { type: 'application/x-chess-pgn' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'chessin-game.pgn'; anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function clockLabel(side: Side) {
    const remaining = sessionRef.current?.remaining(side)
    if (remaining === null || remaining === undefined) return 'Untimed'
    const seconds = Math.ceil(remaining / 1000)
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  }
  void displayTick
  const eloOption = engine.descriptor && supported(engine.descriptor, 'UCI_Elo')
  const skillSupported = engine.descriptor && supported(engine.descriptor, 'Skill Level')
  const eloSupported = engine.descriptor && eloOption && supported(engine.descriptor, 'UCI_LimitStrength')
  const board = useMemo(() => view ? reconstruct(view) : null, [view])
  const playedNodes = useMemo(() => {
    if (!view) return []
    const nodes: GameDocument['nodes'][string][] = []
    let node = view.nodes[view.currentId]
    while (node.parentId) { nodes.push(node); node = view.nodes[node.parentId] }
    return nodes.reverse()
  }, [view])
  return <main className="play-page">
    <header className="play-header"><h1>Play the engine</h1><p>Casual chess · local engine by default · no analysis hints while playing</p></header>
    {!view || !state ? <section className="play-setup" aria-label="New game settings">
      <h2>New game</h2>
      <fieldset><legend>Play as</legend>{(['white', 'black', 'random'] as const).map(value => <label key={value}><input type="radio" name="play-color" checked={color === value} onChange={() => setColor(value)} />{value}</label>)}</fieldset>
      <fieldset><legend>Time control</legend>{(Object.keys(presets).concat('custom') as Preset[]).map(value => <label key={value}><input type="radio" name="play-time" checked={preset === value} onChange={() => setPreset(value)} />{value === 'untimed' ? 'Untimed' : value}</label>)}
        {preset === 'custom' && <div className="play-custom"><label>Minutes (1–180)<input type="number" min="1" max="180" value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></label><label>Increment seconds (0–60)<input type="number" min="0" max="60" value={increment} onChange={event => setIncrement(Number(event.target.value))} /></label></div>}</fieldset>
      <fieldset><legend>Engine strength</legend><p>Check/download the engine first to see its actual supported controls.</p>
        {skillSupported && <label><input type="radio" name="play-strength" checked={strength === 'skill'} onChange={() => setStrength('skill')} />Skill Level <input type="range" aria-label="Skill Level" min="0" max="20" value={skill} onChange={event => setSkill(Number(event.target.value))} /> {skill}</label>}
        {eloSupported && <label><input type="radio" name="play-strength" checked={strength === 'elo'} onChange={() => setStrength('elo')} />Elo <input type="number" aria-label="Engine Elo" min={eloOption.min} max={eloOption.max} value={elo ?? Number(eloOption.default ?? eloOption.min ?? 0)} onChange={event => setElo(Number(event.target.value))} /></label>}
        <label><input type="radio" name="play-strength" checked={strength === 'full'} onChange={() => setStrength('full')} />Full strength</label>
      </fieldset>
      <p>Automatic draws: threefold repetition and 100 reversible halfmoves. A timeout with insufficient mating material is a draw (material-based casual rule).</p>
      <button type="button" onClick={() => void start()} disabled={busy}>{busy ? 'Initializing engine…' : 'Start game'}</button>
      <EngineSettingsPanel />
    </section> : <div className="play-layout">
      <section className="play-board"><div className="play-player"><strong>{state.humanColor === 'b' ? 'You' : state.engineName} · Black</strong><time aria-label="Black clock">{clockLabel('b')}</time></div>
        <AnalysisBoard game={view} orientation={state.humanColor === 'w' ? 'white' : 'black'} onMove={humanMove} disabled={!active || sessionRef.current?.turn !== state.humanColor} />
        <div className="play-player"><strong>{state.humanColor === 'w' ? 'You' : state.engineName} · White</strong><time aria-label="White clock">{clockLabel('w')}</time></div>
        {active && <form className="play-input" onSubmit={event => { event.preventDefault(); if (moveText.trim()) { humanMove(moveText.trim()); setMoveText('') } }}>
          <label htmlFor="play-move-input">Your move (SAN or coordinates)</label>
          <input id="play-move-input" value={moveText} onChange={event => setMoveText(event.target.value)} disabled={sessionRef.current?.turn !== state.humanColor} placeholder="e4 or e2e4" />
          <button type="submit" disabled={sessionRef.current?.turn !== state.humanColor}>Move</button>
        </form>}</section>
      <section className="play-panel" aria-label="Game status"><h2>{state.status === 'finished' ? `${state.result ?? '*'} · ${state.reason}` : state.status === 'interrupted' ? 'Engine interrupted' : state.status === 'suspended' ? 'Game suspended' : `Your game · ${state.humanColor === 'w' ? 'White' : 'Black'}`}</h2>
        <p>{state.provider === 'local' ? 'Local' : 'Remote'} · {state.engineName} {state.engineVersion} · {state.initialMs === null ? 'Untimed' : `${state.initialMs / 60_000}+${state.incrementMs / 1000}`}</p>
        <p aria-live="polite">{state.turn === 'w' ? 'White' : 'Black'} to move{board?.isCheck() ? ' · Check' : ''}</p>
        {state.status === 'interrupted' && <p>Both clocks are stopped. Reconnect to the same engine and choose Resume, or abandon. No automatic retry.</p>}
        {state.status === 'suspended' && <p>Clocks are stopped. Resume explicitly to continue.</p>}
        <ol className="play-moves">{playedNodes.map((node, index) =>
          <li key={node.id}>{index % 2 === 0 ? `${Math.floor(index / 2) + 1}. ` : ''}{node.san}</li>)}</ol>
        <div className="play-actions">{(state.status === 'suspended' || state.status === 'interrupted') && <button type="button" onClick={() => void resume()} disabled={busy}>{busy ? 'Connecting…' : state.status === 'interrupted' ? 'Reconnect and resume' : 'Resume'}</button>}
          {active && <button type="button" onClick={() => { const current = sessionRef.current; if (current) { engine.controller.cancel('play'); current.suspend(); void persist().catch(() => undefined) } }}>Suspend game</button>}
          {state.status !== 'finished' && <button type="button" onClick={() => endGame(true)}>Resign</button>}
          {state.status === 'finished' && <button type="button" onClick={() => { sessionRef.current = null; setSession(null); setView(null); setError('') }}>New game</button>}
          {state.status !== 'finished' && <button type="button" onClick={() => endGame(false)}>Abandon</button>}
          {state.status === 'finished' && <button type="button" onClick={() => void openReview()}>Finish and Review</button>}
          <button type="button" onClick={exportGame}>Export PGN</button></div>
        <p role="status">{saveStatus === 'unsaved' ? 'Unsaved — export PGN to keep your game' : saveStatus === 'saving' ? 'Saving…' : 'Saved locally'}</p>
        {(state.status === 'suspended' || state.status === 'interrupted') && <EngineSettingsPanel />}
      </section>
    </div>}
    {error && <p className="play-error" role="alert">{error}</p>}
  </main>
}
