import { useCallback, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChessBoard, faBookOpen, faChessKnight, faSliders, faCircleInfo, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { createGame, importFen, selectNode, type GameDocument } from '@chessin/core/game'
import { AnalysisPage } from './features/analysis/AnalysisPage'
import { LibraryPage, downloadPgn } from './features/library/LibraryPage'
import { EngineSettingsPanel } from './engine/EngineSettingsPanel'
import { useEngine } from './engine/EngineContext'
import { deleteGame, flushSaves, listGames, loadGame, saveGame } from './storage/db'
import { ReviewPanel } from './features/review/ReviewPanel'
import { PlayPage } from './features/play/PlayPage'
import { readPlayState } from './features/play/play-session'

export type AppPage = 'analysis' | 'library' | 'play' | 'settings' | 'licenses'

export function App() {
  const [page, setPage] = useState<AppPage>('library')
  const [games, setGames] = useState<GameDocument[]>([])
  const [game, setGame] = useState<GameDocument | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [warning, setWarning] = useState('')
  const [playActive, setPlayActive] = useState(false)
  const [reviewFirst, setReviewFirst] = useState(false)
  const [grades, setGrades] = useState<Record<string, { label: string }>>({})
  const suspendPlay = useRef<(() => Promise<void>) | null>(null)
  const registerSuspend = useCallback((suspend: () => Promise<void>) => { suspendPlay.current = suspend }, [])
  const currentRef = useRef<GameDocument | null>(null)
  const latestRef = useRef<GameDocument | null>(null)
  const savePromise = useRef<Promise<void> | null>(null)
  const engine = useEngine()

  useEffect(() => {
    let alive = true
    listGames().then(items => { if (alive) setGames(items) }).catch(error => { if (alive) { setSaveState('unsaved'); setWarning(`${error instanceof Error ? error.message : 'Browser storage unavailable'}. Your current work remains in memory; export PGN before closing this tab.`) } })
    return () => { alive = false }
  }, [])

  const saveChanges = useCallback((next: GameDocument) => {
    currentRef.current = next
    latestRef.current = next
    setGame(next)
    setGames(previous => [next, ...previous.filter(item => item.id !== next.id)])
    setSaveState('saving')
    if (savePromise.current) return
    const drain = async () => {
      while (latestRef.current) {
        const target = latestRef.current
        latestRef.current = null
        try {
          const saved = await saveGame(target)
          if (saved.id !== target.id) {
            const recent = currentRef.current
            if (recent?.id === target.id) {
              const migrated = { ...recent, id: saved.id, title: saved.title, createdAt: saved.createdAt }
              currentRef.current = migrated
              setGame(migrated)
              latestRef.current = recent === target ? null : migrated
              setWarning('Another tab changed this game. Your edits were saved as a separate conflict copy.')
            }
            const updatedOriginal = await loadGame(target.id)
            setGames(previous => [saved, ...(updatedOriginal ? [updatedOriginal] : []), ...previous.filter(item => item.id !== target.id && item.id !== saved.id)])
          }
        } catch (error) {
          if (!latestRef.current) latestRef.current = currentRef.current
          setSaveState('unsaved')
          setWarning(`${error instanceof Error ? error.message : 'Unable to save to browser storage'}. Your work remains in this tab; export PGN now.`)
          break
        }
      }
      if (!latestRef.current) setSaveState('saved')
      savePromise.current = null
    }
    savePromise.current = drain()
  }, [])

  async function settle() { await savePromise.current; await flushSaves() }
  async function navigate(destination: AppPage) {
    if (destination === page) return
    if (playActive) {
      if (!window.confirm('Suspend this game before leaving? Cancel to stay.')) return
      try { await suspendPlay.current?.() } catch { return }
      setPlayActive(false)
    }
    engine.controller.cancel('analysis')
    engine.controller.cancel('review')
    await settle()
    setPage(destination)
  }
  async function open(gameToOpen: GameDocument) {
    await settle()
    currentRef.current = gameToOpen
    setGame(gameToOpen)
    setReviewFirst(false)
    setGrades({})
    const play = readPlayState(gameToOpen)
    setPage(play && play.status !== 'finished' ? 'play' : 'analysis')
  }
  function add(newGame: GameDocument) {
    saveChanges(newGame)
    setPage('analysis')
  }
  async function importGames(incoming: GameDocument[]) {
    await settle()
    let first: GameDocument | null = null
    for (const imported of incoming) {
      try {
        const saved = await saveGame(imported)
        first ??= saved
        setGames(previous => [saved, ...previous.filter(item => item.id !== saved.id)])
      } catch (error) {
        first ??= imported
        setGames(previous => [imported, ...previous.filter(item => item.id !== imported.id)])
        setSaveState('unsaved')
        setWarning(`${error instanceof Error ? error.message : 'Storage failed'}. Imported work stays in this tab; export PGN before leaving.`)
      }
    }
    if (first) { currentRef.current = first; setGame(first); setPage('analysis') }
  }
  async function remove(toDelete: GameDocument) {
    await settle()
    try {
      await deleteGame(toDelete.id)
      setGames(previous => previous.filter(item => item.id !== toDelete.id))
      if (game?.id === toDelete.id) { setGame(null); currentRef.current = null }
    } catch (error) { setWarning(`${error instanceof Error ? error.message : 'Delete failed'}. Game was not deleted.`) }
  }
  function rename(target: GameDocument, title: string) {
    const renamed = { ...target, title, revision: target.revision + 1, updatedAt: new Date().toISOString() }
    if (game?.id === target.id) saveChanges(renamed)
    else void saveGame(renamed).then(saved => setGames(previous => [saved, ...previous.filter(item => item.id !== target.id && item.id !== saved.id)])).catch(error => { setWarning(`Could not save rename: ${error instanceof Error ? error.message : 'storage error'}`); setSaveState('unsaved') })
  }
  async function exportCurrent() { await settle(); if (currentRef.current) downloadPgn(currentRef.current) }
  const playChanged = useCallback((next: GameDocument) => {
    currentRef.current = next
    setGame(next)
    setGames(previous => [next, ...previous.filter(item => item.id !== next.id)])
  }, [])
  function finishAndReview(finished: GameDocument) {
    playChanged(finished)
    setPlayActive(false)
    setReviewFirst(true)
    setGrades({})
    setPage('analysis')
  }
  async function exportLibrary(target: GameDocument) { await settle(); downloadPgn(currentRef.current?.id === target.id ? currentRef.current : target) }
  const nav: { id: AppPage; icon: IconDefinition; label: string }[] = [
    { id: 'analysis', icon: faChessBoard, label: 'Analysis' }, { id: 'library', icon: faBookOpen, label: 'Library' },
    { id: 'play', icon: faChessKnight, label: 'Play' },
    { id: 'settings', icon: faSliders, label: 'Settings' }, { id: 'licenses', icon: faCircleInfo, label: 'Licenses' },
  ]

  return <div className="app-shell">
    <nav className="navigation" aria-label="Main navigation"><button className="brand" onClick={() => void navigate('library')} aria-label="ChessIn home"><span className="brand-mark"><FontAwesomeIcon icon={faChessKnight} aria-hidden="true" /></span><span className="brand-name">chessin<span className="brand-dot">.</span></span></button><div className="nav-items">{nav.map(item => <button key={item.id} onClick={() => void navigate(item.id)} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined}><span className="nav-icon" aria-hidden="true"><FontAwesomeIcon icon={item.icon} /></span><span className="nav-label">{item.label}</span></button>)}</div><span className="nav-footer" title="Analysis stays on this device">LOCAL FIRST</span></nav>
    <main className="main-content">
      <div className="topbar"><span className="mobile-brand"><FontAwesomeIcon icon={faChessKnight} aria-hidden="true" /> chessin<span>.</span></span><span className="topbar-path">WORKSPACE <span>/</span> {page.toUpperCase()}</span><div className="topbar-right">{page !== 'play' && <span className={`save-indicator ${saveState}`} role="status"><span className="status-dot" />{saveState === 'saving' ? 'Saving…' : saveState === 'unsaved' ? 'Unsaved' : 'Saved locally'}</span>}<span className="provider-badge">{engine.provider === 'remote' ? '↗ Remote' : '◉ Local'} · {engine.descriptor?.name || engine.status}</span></div></div>
      {warning && <div className="storage-warning" role="alert"><div><strong>{saveState === 'unsaved' ? 'Storage needs attention' : 'Library notice'}</strong><span>{warning}</span></div><div className="warning-actions">{game && <button onClick={() => void exportCurrent()}>Export current PGN</button>}<button onClick={() => setWarning('')} aria-label="Dismiss notice">×</button></div></div>}
      {page === 'analysis' && (game ? <AnalysisPage key={game.id} game={game} onChange={saveChanges} initialPane={reviewFirst ? 'review' : 'moves'} grades={grades} reviewPanel={<ReviewPanel game={game} onSelect={id => saveChanges(selectNode(game, id))} onGrades={setGrades} />} /> : <div className="welcome-analysis"><span className="eyebrow">ANALYSIS BOARD</span><h1>Ready when you are.</h1><p>Open a game or start from the initial position.</p><div className="hero-actions"><button className="primary-button" onClick={() => add(createGame())}>New analysis</button><button onClick={() => void navigate('library')}>Browse library</button></div></div>)}
      {page === 'play' && <PlayPage game={game?.play ? game : undefined} onChange={playChanged} onReview={finishAndReview} onActiveChange={setPlayActive} onSuspendReady={registerSuspend} />}
      {page === 'library' && <LibraryPage games={games} onOpen={open} onImport={importGames} onFen={fen => add(importFen(fen))} onNew={() => add(createGame())} onDelete={remove} onRename={rename} onExport={exportLibrary} onError={setWarning} />}
      {page === 'settings' && <section className="settings-page"><header className="settings-page-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h1>Settings</h1><p>Your engine. Your preferences. Always in your control.</p></div><span className="settings-local-note">Local first. No account required.</span></header><EngineSettingsPanel /></section>}
      {page === 'licenses' && <section className="utility-page"><span className="eyebrow">OPEN SOURCE</span><h1>Licenses & sources</h1><p>ChessIn is GPLv3 software. The chessboard uses the package’s licensed built-in pieces; no third-party logos or external fonts are used.</p><div className="settings-card"><h2>Complete corresponding source</h2><p>Browser Stockfish.js © 2026 Chess.com LLC and Stockfish developers; native Stockfish © Stockfish developers. Both are GPLv3. Source archives, build instructions and required network files are distributed locally alongside the binaries.</p><ul className="source-list"><li><a href="/LICENSE">ChessIn GPLv3 license</a></li><li><a href="/THIRD-PARTY-NOTICES.txt">Third-party notices and board-package attribution</a></li><li><a href="/sources/README.txt">Build instructions and authorship</a></li><li><a href="/sources/Stockfish-AUTHORS.txt">Stockfish contributors</a></li><li><a href="/sources/stockfish-js-v19.0.0.tar.gz">Stockfish.js v19 source archive</a></li><li><a href="/sources/Stockfish-sf_19.tar.gz">Native Stockfish 19 source archive</a></li><li><a href="/sources/nn-1a298aa575a0.nnue">Stockfish network 1</a></li><li><a href="/sources/nn-61e7af4bb97d.nnue">Stockfish network 2</a></li></ul></div></section>}
      {page === 'licenses' && <section className="utility-page"><h2>ChessIn application source</h2><p><a href="/sources/chessin-source.tar.gz">Download this build’s complete application source</a>, including the npm lockfile and deployment configuration. Extract it and follow README.md to rebuild; engine preparation downloads the pinned, verified release assets.</p></section>}
    </main>
  </div>
}
