import { useEffect, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { EngineSettingsPanel } from './EngineSettingsPanel'
import './engine-drawer.css'

export function EngineSettingsDrawer({ disabled, onClose }: { disabled: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.showModal()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { element.close(); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }) }
  }, [])

  return <dialog ref={dialog} className="engine-settings-drawer" aria-labelledby="engine-drawer-title" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose() } }}>
    <header className="engine-drawer-heading"><div><span className="eyebrow">BOARD SETTINGS</span><h2 id="engine-drawer-title">Engine settings</h2></div><button type="button" onClick={onClose} aria-label="Close engine settings"><FontAwesomeIcon icon={faXmark} /></button></header>
    {disabled && <p className="engine-drawer-notice" role="status">Game analysis is running. Close this drawer and pause analysis to change engine settings.</p>}
    <fieldset className="engine-drawer-content" disabled={disabled}><legend className="sr-only">Engine configuration</legend><EngineSettingsPanel /></fieldset>
  </dialog>
}
