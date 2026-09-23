import { useRef, useState } from 'react'
import type { GameDocument } from '@chessin/core/game'
import { exportPgn, importPgn } from '@chessin/core/pgn'
import { useDialogFocus } from '../../components/useDialogFocus'

export interface LibraryPageProps {
  games: GameDocument[]
  onOpen: (game: GameDocument) => void | Promise<void>
  onImport: (games: GameDocument[]) => void | Promise<void>
  onFen: (fen: string) => void | Promise<void>
  onNew: () => void | Promise<void>
  onDelete: (game: GameDocument) => void | Promise<void>
  onRename: (game: GameDocument, title: string) => void | Promise<void>
  onExport: (game: GameDocument) => void | Promise<void>
  onError?: (message: string) => void
}

const example = `[Event "ChessIn example · Scholar's mate"]
[Site "Local example"]
[White "Example White"]
[Black "Example Black"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0`

export function downloadPgn(game: GameDocument): void {
  const url = URL.createObjectURL(new Blob([exportPgn(game)], { type: 'application/x-chess-pgn;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${game.title.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'game'}.pgn`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function LibraryPage({ games, onOpen, onImport, onFen, onNew, onDelete, onRename, onExport, onError }: LibraryPageProps) {
  const [query, setQuery] = useState('')
  const [modal, setModal] = useState<'pgn' | 'fen' | null>(null)
  useDialogFocus('.import-dialog', !!modal, () => setModal(null))
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const upload = useRef<HTMLInputElement>(null)
  const filtered = games.filter(game => [game.title, game.headers.White, game.headers.Black, game.headers.Event].some(value => value?.toLowerCase().includes(query.toLowerCase())))

  async function submit() {
    try {
      if (modal === 'pgn') {
        const imported = importPgn(text)
        if (!imported.length) throw new Error('No games found in this PGN')
        await onImport(imported)
      } else if (modal === 'fen') await onFen(text.trim())
      setModal(null); setText(''); setError('')
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Import failed') }
  }
  function open(kind: 'pgn' | 'fen') { setModal(kind); setText(''); setError('') }

  return <section className="library-page">
    <header className="library-hero"><span className="eyebrow">YOUR CHESS WORKSPACE</span><h1>Every game has a story.</h1><p>Explore it at your pace. Your library stays in this browser, not on a server.</p><div className="hero-actions"><button className="primary-button" onClick={onNew}>＋ New analysis</button><button onClick={() => open('pgn')}>Import PGN</button><button onClick={() => open('fen')}>Paste FEN</button></div></header>
    <div className="library-heading"><div><span className="eyebrow">LOCAL COLLECTION</span><h2>Game library <span className="count">{games.length}</span></h2></div><label className="search-box"><span className="sr-only">Search by title or player</span><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search games or players" /></label></div>
    {games.length === 0 ? <div className="empty-library"><div className="empty-symbol">♞</div><h2>Your next move starts here.</h2><p>Import your PGN, paste a position, or set up a fresh board. Nothing is uploaded.</p><div className="hero-actions"><button className="primary-button" onClick={() => open('pgn')}>Import PGN</button><button onClick={() => open('fen')}>Paste FEN</button><button onClick={onNew}>New analysis</button></div><button className="example-link" onClick={async () => { try { await onImport(importPgn(example)) } catch (problem) { onError?.(problem instanceof Error ? problem.message : 'Unable to load example') } }}>Or explore an explicitly labeled example game →</button></div> : filtered.length === 0 ? <div className="empty-library"><h2>No games match “{query}”.</h2><button onClick={() => setQuery('')}>Clear search</button></div> : <div className="game-grid">{filtered.map(game => <article className="game-card" key={game.id}><div className="game-card-top"><span className="game-icon">♙</span><span className="game-date">{new Date(game.updatedAt).toLocaleDateString()}</span></div><h3>{game.title}</h3><p>{game.headers.White || 'White'} <span>vs</span> {game.headers.Black || 'Black'}</p><div className="game-meta"><span>{Object.keys(game.nodes).length - 1} positions</span><span>{game.headers.Result || 'Analysis'}</span></div><div className="game-actions"><button className="primary-button" onClick={() => onOpen(game)}>Open board</button><button onClick={() => { const title = window.prompt('Rename game', game.title)?.trim(); if (title && title !== game.title) void onRename(game, title) }} aria-label={`Rename ${game.title}`}>Rename</button><button onClick={() => void onExport(game)} aria-label={`Export ${game.title} as PGN`}>Export</button><button className="danger-text" onClick={() => { if (window.confirm(`Delete “${game.title}” from this browser? Export first if you need a copy.`)) void onDelete(game) }} aria-label={`Delete ${game.title}`}>Delete</button></div></article>)}</div>}
    {modal && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setModal(null) }}><div className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title"><button className="dialog-close" onClick={() => setModal(null)} aria-label="Close import dialog">×</button><span className="eyebrow">BRING YOUR GAMES</span><h2 id="import-title">{modal === 'pgn' ? 'Import PGN' : 'Paste a FEN position'}</h2><p>{modal === 'pgn' ? 'Multiple games and variations are preserved. Import is all-or-nothing.' : 'A FEN contains only one position; earlier move and repetition history cannot be recovered.'}</p>{modal === 'pgn' && <><input className="sr-only" type="file" accept=".pgn,text/plain,application/x-chess-pgn" ref={upload} onChange={async event => { const file = event.target.files?.[0]; if (file) { if (file.size > 2 * 1024 * 1024) setError('PGN exceeds 2 MiB'); else { setText(await file.text()); setError('') } } }} /><button onClick={() => upload.current?.click()}>Choose .pgn file</button></>}<label className="textarea-label" htmlFor="import-text">{modal === 'pgn' ? 'PGN text' : 'FEN'}</label><textarea id="import-text" value={text} onChange={event => setText(event.target.value)} rows={modal === 'pgn' ? 10 : 4} placeholder={modal === 'pgn' ? '1. e4 e5 2. Nf3 …' : 'Piece placement active-color castling en-passant halfmove fullmove'} />{error && <p className="inline-error" role="alert">{error}</p>}<div className="dialog-actions"><button onClick={() => setModal(null)}>Cancel</button><button className="primary-button" onClick={() => void submit()} disabled={!text.trim()}>Import</button></div></div></div>}
  </section>
}
