import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRight, faBolt, faBookOpen, faChessBoard, faChessKing, faChessKnight, faChessPawn, faClock, faFileExport, faFlag, faListOl, faPause, faPlay, faRotateRight, faShuffle, faSliders } from '@fortawesome/free-solid-svg-icons'
import { createGame, getPosition, reconstruct, type GameDocument } from '@chessin/core/game'
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

const setupTabs = [
  { id: 'new', label: 'New game', icon: faChessKnight },
  { id: 'engine', label: 'Engine', icon: faSliders },
  { id: 'rules', label: 'Rules', icon: faBookOpen },
] as const
const gameTabs = [
  { id: 'moves', label: 'Moves', icon: faListOl },
  { id: 'details', label: 'Game details', icon: faChessBoard },
] as const

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
  const [setupTab, setSetupTab] = useState<(typeof setupTabs)[number]['id']>('new')
  const [gameTab, setGameTab] = useState<(typeof gameTabs)[number]['id']>('moves')
  const tabId = useId()
  const preview = useMemo(() => createGame(), [])
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
  const skillOption = skillSupported?.type === 'spin' ? skillSupported : null
  const skillMin = Math.max(0, skillOption?.min ?? 0)
  const skillMax = Math.min(20, skillOption?.max ?? 20)
  const selectedMinutes = preset === 'custom' ? minutes : presets[preset][0]
  const selectedIncrement = preset === 'custom' ? increment : presets[preset][1]
  const timeSummary = selectedMinutes === null ? 'Untimed' : `${selectedMinutes}+${selectedIncrement}`
  const strengthSummary = strength === 'full' ? 'Full strength' : strength === 'elo'
    ? eloSupported?.type === 'check' && eloOption?.type === 'spin' ? `Engine Elo ${elo ?? Number(eloOption.default ?? eloOption.min ?? 0)}` : engine.descriptor ? 'Elo unavailable · choose Full strength' : 'Elo · initialize engine'
    : skillOption ? `Skill level ${Math.max(skillMin, Math.min(skillMax, skill))}` : engine.descriptor ? 'Skill unavailable · choose Full strength' : 'Skill · initialize engine'
  const handleTabKey = <T extends string>(event: KeyboardEvent<HTMLButtonElement>, tabs: readonly { id: T }[], index: number, select: (id: T) => void) => {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : -1
    if (next < 0) return
    event.preventDefault()
    select(tabs[next].id)
    document.getElementById(`${tabId}-${tabs[next].id}-tab`)?.focus()
  }
  const statusTitle = state?.status === 'finished' ? 'Game complete' : state?.status === 'interrupted'
    ? 'Engine interrupted' : state?.status === 'suspended' ? 'Game suspended' : 'Game in progress'
  const resultLabel = state?.result === '1-0' ? 'White wins' : state?.result === '0-1' ? 'Black wins'
    : state?.result === '1/2-1/2' ? 'Draw' : null
  const previewTop = color === 'black' ? 'white' : 'black'
  const previewBottom = color === 'black' ? 'black' : 'white'
  const topSide: Side = state?.humanColor === 'b' ? 'w' : 'b'
  return <main className="play-page">
    <header className="play-header"><div className="play-heading-icon" aria-hidden="true"><FontAwesomeIcon icon={faChessKnight} /></div>
      <div><span className="play-eyebrow">CHESSIN · PLAY</span><h1>Play the engine</h1>
        <p>Casual chess against your chosen engine. No analysis or hints while the game is active.</p></div>
    </header>
    {!view || !state ? <div className="play-layout play-setup-layout">
      <section className="play-preview" aria-label="Starting position preview">
        <div className="play-preview-heading"><div><span className="play-eyebrow">YOUR NEXT GAME</span><h2>Ready when you are.</h2></div><span className="play-preview-tag"><FontAwesomeIcon icon={faChessBoard} /> Starting position</span></div>
        <div className="play-preview-player"><span className={`play-player-piece ${previewTop === 'white' ? 'light' : 'dark'}`} aria-hidden="true">{previewTop === 'white' ? '♔' : '♚'}</span><strong>{previewTop === 'white' ? 'White' : 'Black'}</strong><span className="play-preview-side">{color === 'random' ? 'To be decided' : 'Engine'}</span></div>
        <div className="play-preview-board"><AnalysisBoard game={preview} orientation={color === 'black' ? 'black' : 'white'} onMove={() => undefined} disabled /></div>
        <div className="play-preview-player"><span className={`play-player-piece ${previewBottom === 'white' ? 'light' : 'dark'}`} aria-hidden="true">{previewBottom === 'white' ? '♔' : '♚'}</span><strong>{previewBottom === 'white' ? 'White' : 'Black'}</strong><span className="play-preview-side">{color === 'random' ? 'To be decided' : 'You'}</span></div>
        <p className="play-preview-note">The board is a preview. Pieces can be moved after the engine is ready and the game starts.</p>
      </section>
      <section className="play-setup play-panel" aria-label="New game settings">
        <div className="play-panel-head"><span className="play-eyebrow">SET UP YOUR MATCH</span><h2>New game</h2><p>Choose your side and time control, then start when you’re ready.</p></div>
        <div className="play-tabs" role="tablist" aria-label="New game sections">
          {setupTabs.map((tab, index) => <button key={tab.id} id={`${tabId}-${tab.id}-tab`} type="button" role="tab" aria-selected={setupTab === tab.id} aria-controls={`${tabId}-${tab.id}-panel`} tabIndex={setupTab === tab.id ? 0 : -1} onClick={() => setSetupTab(tab.id)} onKeyDown={event => handleTabKey(event, setupTabs, index, setSetupTab)}><FontAwesomeIcon icon={tab.icon} aria-hidden="true" />{tab.label}</button>)}
        </div>
        <div className="play-tab-content" id={`${tabId}-new-panel`} role="tabpanel" aria-labelledby={`${tabId}-new-tab`} hidden={setupTab !== 'new'} tabIndex={0}>
          <fieldset className="play-fieldset"><legend>Play as</legend><div className="play-choice-grid play-color-grid">
            {(['white', 'black', 'random'] as const).map(value => <label key={value} className="play-choice">
              <input type="radio" name="play-color" checked={color === value} onChange={() => setColor(value)} />
              <span className="play-choice-body"><span className="play-choice-icon"><FontAwesomeIcon icon={value === 'random' ? faShuffle : value === 'white' ? faChessKing : faChessPawn} aria-hidden="true" /></span><strong>{value === 'random' ? 'Random' : value === 'white' ? 'White' : 'Black'}</strong><small>{value === 'white' ? 'Move first' : value === 'black' ? 'Move second' : 'Surprise me'}</small></span>
            </label>)}
          </div></fieldset>
          <fieldset className="play-fieldset"><legend>Time control</legend><div className="play-choice-grid play-time-grid">
            {(Object.keys(presets).concat('custom') as Preset[]).map(value => <label key={value} className="play-choice">
              <input type="radio" name="play-time" checked={preset === value} onChange={() => setPreset(value)} />
              <span className="play-choice-body"><FontAwesomeIcon icon={value === 'untimed' ? faChessBoard : faClock} aria-hidden="true" /><strong>{value === 'untimed' ? 'Untimed' : value === 'custom' ? 'Custom' : value}</strong><small>{value === 'untimed' ? 'No clock' : value === 'custom' ? 'Your own pace' : `${presets[value][0]} min · ${presets[value][1]} sec increment`}</small></span>
            </label>)}
          </div>
            {preset === 'custom' && <div className="play-custom"><label>Minutes per side <input type="number" inputMode="numeric" min="1" max="180" value={minutes} onChange={event => setMinutes(Number(event.target.value))} /><small>1–180 minutes</small></label><label>Increment per move <input type="number" inputMode="numeric" min="0" max="60" value={increment} onChange={event => setIncrement(Number(event.target.value))} /><small>0–60 seconds</small></label></div>}
          </fieldset>
          <fieldset className="play-fieldset play-strength"><legend>Engine strength</legend><p>Only controls advertised by the selected engine appear after it is initialized.</p>
            {skillOption && skillMax >= skillMin && <label className="play-strength-option"><input type="radio" name="play-strength" checked={strength === 'skill'} onChange={() => setStrength('skill')} /><span>Skill level</span><output>{Math.max(skillMin, Math.min(skillMax, skill))}</output></label>}
            {skillOption && skillMax >= skillMin && strength === 'skill' && <label className="play-range"><span>Choose skill level <small>{skillMin}–{skillMax}</small></span><input type="range" aria-label="Skill level" min={skillMin} max={skillMax} value={Math.max(skillMin, Math.min(skillMax, skill))} onChange={event => setSkill(Number(event.target.value))} /></label>}
            {!engine.descriptor && strength === 'skill' && <p className="play-strength-pending">Skill level {skill} requested. Initialize the engine to confirm this control is available, or choose Full strength.</p>}
            {engine.descriptor && ((strength === 'skill' && !skillOption) || (strength === 'elo' && (!eloOption || eloSupported?.type !== 'check'))) && <p className="play-strength-pending">This engine does not support the selected strength control. Choose Full strength or another supported option.</p>}
            {eloSupported?.type === 'check' && eloOption?.type === 'spin' && <label className="play-strength-option"><input type="radio" name="play-strength" checked={strength === 'elo'} onChange={() => setStrength('elo')} /><span>Engine Elo</span><input type="number" aria-label="Engine Elo" min={eloOption.min} max={eloOption.max} value={elo ?? Number(eloOption.default ?? eloOption.min ?? 0)} onChange={event => setElo(Number(event.target.value))} /></label>}
            <label className="play-strength-option"><input type="radio" name="play-strength" checked={strength === 'full'} onChange={() => setStrength('full')} /><span>Full strength</span><FontAwesomeIcon icon={faBolt} aria-hidden="true" /></label>
          </fieldset>
        </div>
        <div className="play-tab-content" id={`${tabId}-engine-panel`} role="tabpanel" aria-labelledby={`${tabId}-engine-tab`} hidden={setupTab !== 'engine'} tabIndex={0}><EngineSettingsPanel /></div>
        <div className="play-tab-content play-rules" id={`${tabId}-rules-panel`} role="tabpanel" aria-labelledby={`${tabId}-rules-tab`} hidden={setupTab !== 'rules'} tabIndex={0}>
          <h3>Casual game rules</h3><p>Standard chess, with the full legal move set. Timed games begin only after the engine is ready.</p>
          <ul><li>Checkmate, stalemate and insufficient material end the game.</li><li>Threefold repetition and 100 reversible halfmoves are automatic draws.</li><li>On timeout, the result is a draw if the other side has insufficient mating material under the material-based casual rule.</li><li>Suspend to stop both clocks. Resignation ends the game; you can export or review a completed game.</li></ul>
        </div>
        <div className="play-start"><div><span className="play-eyebrow">YOUR MATCH</span><strong>{color === 'random' ? 'Random side' : `Play as ${color}`} · {timeSummary}</strong><small>{engine.provider === 'local' ? 'On-device' : 'Remote'} {engine.descriptor?.name ?? 'engine'} · {strengthSummary}</small></div>
          <button type="button" className="play-primary" onClick={() => void start()} disabled={busy}><FontAwesomeIcon icon={faPlay} aria-hidden="true" />{busy ? 'Initializing engine…' : 'Start game'}<FontAwesomeIcon icon={faArrowRight} aria-hidden="true" /></button>
        </div>
      </section>
    </div> : <div className="play-layout">
      <section className="play-board" aria-label="Game board"><div className="play-player"><span className="play-player-name"><span className={`play-player-piece ${topSide === 'w' ? 'light' : 'dark'}`} aria-hidden="true">{topSide === 'w' ? '♔' : '♚'}</span><strong>{state.engineName}</strong><small>{topSide === 'w' ? 'White' : 'Black'}</small></span><time aria-label={`${topSide === 'w' ? 'White' : 'Black'} clock`}>{clockLabel(topSide)}</time></div>
        <AnalysisBoard game={view} orientation={state.humanColor === 'w' ? 'white' : 'black'} onMove={humanMove} disabled={!active || sessionRef.current?.turn !== state.humanColor} />
        <div className="play-player"><span className="play-player-name"><span className={`play-player-piece ${state.humanColor === 'w' ? 'light' : 'dark'}`} aria-hidden="true">{state.humanColor === 'w' ? '♔' : '♚'}</span><strong>You</strong><small>{state.humanColor === 'w' ? 'White' : 'Black'}</small></span><time aria-label={`${state.humanColor === 'w' ? 'White' : 'Black'} clock`}>{clockLabel(state.humanColor)}</time></div>
        {active && <form className="play-input" onSubmit={event => { event.preventDefault(); if (moveText.trim()) { humanMove(moveText.trim()); setMoveText('') } }}>
          <label htmlFor="play-move-input">Your move (SAN or coordinates)</label>
          <input id="play-move-input" value={moveText} onChange={event => setMoveText(event.target.value)} disabled={sessionRef.current?.turn !== state.humanColor} placeholder="e4 or e2e4" />
          <button type="submit" disabled={sessionRef.current?.turn !== state.humanColor}>Move</button>
        </form>}</section>
      <section className="play-panel play-game-panel" aria-label="Game status">
        <div className="play-panel-head"><span className="play-eyebrow">{state.provider === 'local' ? 'ON-DEVICE GAME' : 'REMOTE ENGINE GAME'}</span><h2>{statusTitle}</h2><p>{state.engineName} {state.engineVersion} · {state.initialMs === null ? 'Untimed' : `${state.initialMs / 60_000}+${state.incrementMs / 1000}`}</p></div>
        <div className={`play-status ${state.status}`} aria-live="polite"><span className="play-status-dot" />
          {state.status === 'finished' ? `${resultLabel ?? state.result ?? 'Game over'} · ${state.reason ?? 'Game finished'}` : state.status === 'interrupted' ? 'Engine interrupted · both clocks stopped' : state.status === 'suspended' ? 'Suspended · both clocks stopped' : `${state.turn === 'w' ? 'White' : 'Black'} to move${board?.isCheck() ? ' · Check' : ''}`}
        </div>
        <div className="play-tabs" role="tablist" aria-label="Game sections">
          {gameTabs.map((tab, index) => <button key={tab.id} id={`${tabId}-${tab.id}-tab`} type="button" role="tab" aria-selected={gameTab === tab.id} aria-controls={`${tabId}-${tab.id}-panel`} tabIndex={gameTab === tab.id ? 0 : -1} onClick={() => setGameTab(tab.id)} onKeyDown={event => handleTabKey(event, gameTabs, index, setGameTab)}><FontAwesomeIcon icon={tab.icon} aria-hidden="true" />{tab.label}</button>)}
        </div>
        <div className="play-tab-content" id={`${tabId}-moves-panel`} role="tabpanel" aria-labelledby={`${tabId}-moves-tab`} hidden={gameTab !== 'moves'} tabIndex={0}>
          <div className="play-move-heading"><strong>Moves</strong><span>{playedNodes.length} {playedNodes.length === 1 ? 'ply' : 'plies'}</span></div>
          {playedNodes.length ? <ol className="play-moves" aria-label="Played moves">{playedNodes.map((node, index) => index % 2 === 0 ? <li key={node.id}><span className="play-move-number">{Math.floor(index / 2) + 1}.</span><span>{node.san}</span><span>{playedNodes[index + 1]?.san ?? '…'}</span></li> : null)}</ol> : <p className="play-empty-moves">The first move will appear here.</p>}
        </div>
        <div className="play-tab-content play-details" id={`${tabId}-details-panel`} role="tabpanel" aria-labelledby={`${tabId}-details-tab`} hidden={gameTab !== 'details'} tabIndex={0}>
          <dl><div><dt>White</dt><dd>{view.headers.White ?? (state.humanColor === 'w' ? 'You' : state.engineName)} · {clockLabel('w')}</dd></div><div><dt>Black</dt><dd>{view.headers.Black ?? (state.humanColor === 'b' ? 'You' : state.engineName)} · {clockLabel('b')}</dd></div><div><dt>Time control</dt><dd>{state.initialMs === null ? 'Untimed' : `${state.initialMs / 60_000} min + ${state.incrementMs / 1000} sec`}</dd></div><div><dt>Engine</dt><dd>{state.provider === 'local' ? 'On device' : 'Remote'} · {state.engineName} {state.engineVersion}</dd></div><div><dt>Result</dt><dd>{state.status === 'finished' ? `${state.result ?? '*'} · ${state.reason ?? 'Game finished'}` : 'In progress'}</dd></div></dl>
          {state.status === 'interrupted' && <p>Reconnect to the same engine and choose Resume, or abandon. No automatic retry.</p>}
          {state.status === 'suspended' && <p>Clocks are stopped. Resume explicitly to continue.</p>}
          {(state.status === 'suspended' || state.status === 'interrupted') && <EngineSettingsPanel />}
        </div>
        <div className="play-actions">
          {(state.status === 'suspended' || state.status === 'interrupted') && <button type="button" className="play-primary" onClick={() => void resume()} disabled={busy}><FontAwesomeIcon icon={faRotateRight} aria-hidden="true" />{busy ? 'Connecting…' : state.status === 'interrupted' ? 'Reconnect and resume' : 'Resume game'}</button>}
          {active && <button type="button" onClick={() => { const current = sessionRef.current; if (current) { engine.controller.cancel('play'); current.suspend(); void persist().catch(() => undefined) } }}><FontAwesomeIcon icon={faPause} aria-hidden="true" />Suspend game</button>}
          {state.status !== 'finished' && <button type="button" className="play-danger" onClick={() => endGame(true)}><FontAwesomeIcon icon={faFlag} aria-hidden="true" />Resign</button>}
          {state.status !== 'finished' && <button type="button" className="play-danger" onClick={() => endGame(false)}>Abandon</button>}
          {state.status === 'finished' && <><button type="button" className="play-primary" onClick={() => void openReview()}><FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />Finish and Review</button><button type="button" onClick={() => { sessionRef.current = null; setSession(null); setView(null); setError('') }}>New game</button></>}
          <button type="button" onClick={exportGame}><FontAwesomeIcon icon={faFileExport} aria-hidden="true" />Export PGN</button>
        </div>
        <p className="play-save-status" role="status">{saveStatus === 'unsaved' ? 'Unsaved — export PGN to keep your game' : saveStatus === 'saving' ? 'Saving…' : 'Saved locally'}</p>
      </section>
    </div>}
    {error && <p className="play-error" role="alert">{error}</p>}
  </main>
}
