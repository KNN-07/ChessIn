import { useEffect, useId, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faSliders, faXmark, faArrowRight, faMicrochip } from '@fortawesome/free-solid-svg-icons'
import { useEngine } from './EngineContext'
import './quick-engine.css'

const depths = [8, 10, 12, 16, 18, 20, 24, 30]
const times = [500, 1000, 1500, 3000, 5000, 10000, 30000]

export function QuickEngineSettings({ disabled, onOpenSettings }: { disabled: boolean; onOpenSettings: () => void }) {
  const engine = useEngine()
  const id = useId()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const multiPv = engine.descriptor?.options.find(option => option.name.toLowerCase() === 'multipv')
  const minLines = multiPv?.type === 'spin' ? Math.max(1, multiPv.min ?? 1) : 1
  const maxLines = multiPv?.type === 'spin' ? Math.min(5, multiPv.max ?? 5, engine.remoteLimits?.maxMultiPv ?? 5) : 1

  useEffect(() => {
    if (!open) return
    close.current?.focus({ preventScroll: true })
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [open])

  function setBound(key: 'depth' | 'moveTimeMs', raw: string, min: number, max: number) {
    if (engine.limit.kind !== 'bounded') return
    const value = raw === '' ? undefined : Number(raw)
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) return
    const next = { ...engine.limit, [key]: value }
    if (next.depth === undefined && next.moveTimeMs === undefined && next.nodes === undefined) return
    engine.setLimit(next)
  }

  return <aside className="quick-engine-rail" aria-label="Board quick settings">
    <button ref={trigger} className="quick-engine-tab" aria-label="Quick engine settings" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><FontAwesomeIcon icon={faSliders} /><span>Engine</span></button>
    {open && <section id={id} className="quick-engine-drawer" aria-labelledby={`${id}-heading`}>
      <header><div><span className="eyebrow">BOARD TOOLS</span><h2 id={`${id}-heading`}>Quick settings</h2></div><button ref={close} aria-label="Close quick settings" onClick={() => { setOpen(false); trigger.current?.focus() }}><FontAwesomeIcon icon={faXmark} /></button></header>
      <div className="quick-engine-identity"><FontAwesomeIcon icon={faMicrochip} /><div><strong>{engine.descriptor?.name ?? 'Engine not initialized'}</strong><span>{engine.provider === 'local' ? 'On-device analysis' : 'Connected remote provider'} · Full strength</span></div></div>
      <fieldset disabled={disabled}>
        <legend>Analysis search</legend>
        <label>Search mode<select value={engine.limit.kind} onChange={event => engine.setLimit(event.target.value === 'infinite' ? { kind: 'infinite' } : { kind: 'bounded', depth: 18, moveTimeMs: 5000 })}><option value="bounded">Depth / time limit</option><option value="infinite">Until I stop it</option>{engine.limit.kind === 'clock' && <option value="clock">Game clock</option>}</select></label>
        {engine.limit.kind === 'bounded' && <>
          <label>Depth<select value={engine.limit.depth ?? ''} onChange={event => setBound('depth', event.target.value, 1, 60)}><option value="" disabled={engine.limit.moveTimeMs === undefined && engine.limit.nodes === undefined}>No depth limit</option>{depths.map(depth => <option key={depth} value={depth}>{depth} plies</option>)}{engine.limit.depth !== undefined && !depths.includes(engine.limit.depth) && <option value={engine.limit.depth}>{engine.limit.depth} plies · custom</option>}</select></label>
          <label>Time limit<select value={engine.limit.moveTimeMs ?? ''} onChange={event => setBound('moveTimeMs', event.target.value, 100, 300000)}><option value="" disabled={engine.limit.depth === undefined && engine.limit.nodes === undefined}>No time limit</option>{times.map(time => <option key={time} value={time}>{time / 1000} seconds</option>)}{engine.limit.moveTimeMs !== undefined && !times.includes(engine.limit.moveTimeMs) && <option value={engine.limit.moveTimeMs}>{engine.limit.moveTimeMs / 1000} seconds · custom</option>}</select><small>Stops at the first reached limit.</small></label>
          {engine.limit.nodes !== undefined && <p className="quick-engine-note">Node limit: {engine.limit.nodes.toLocaleString()}. Edit it in full Settings.</p>}
        </>}
        {multiPv?.type === 'spin' && maxLines >= minLines && <label>Engine lines<select value={engine.settings.multiPv ?? minLines} disabled={minLines === maxLines} onChange={event => engine.setSettings({ ...engine.settings, multiPv: Number(event.target.value) })}>{Array.from({ length: maxLines - minLines + 1 }, (_, index) => minLines + index).map(count => <option key={count} value={count}>{count} {count === 1 ? 'line' : 'lines'}</option>)}</select></label>}
      </fieldset>
      <p className="quick-engine-note">{disabled ? 'Review has its own search settings. Switch to Moves or Engine to change analysis preferences.' : engine.limit.kind === 'infinite' ? 'Continuous analysis uses more CPU and battery. Stop it from the board.' : 'Changes apply to the next search, or restart analysis if it is running.'}</p>
      <footer><p>Downloads, hardware and connections live in Settings—not on your board.</p><button onClick={onOpenSettings}>Open full Settings <FontAwesomeIcon icon={faArrowRight} /></button></footer>
    </section>}
  </aside>
}
