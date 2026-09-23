import { useEffect, useRef } from 'react'

/** Keep keyboard focus within a mounted modal and restore its invoking control. */
export function useDialogFocus(selector: string, open: boolean, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const dialog = document.querySelector<HTMLElement>(selector)
    if (!dialog) return
    const previous = document.activeElement as HTMLElement | null
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"]')).filter(element => element.getClientRects().length > 0)
    ;(dialog.querySelector<HTMLElement>('textarea') ?? controls()[0])?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const list = controls(), first = list[0], last = list[list.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog.addEventListener('keydown', keydown)
    return () => { dialog.removeEventListener('keydown', keydown); previous?.focus() }
  }, [selector, open])
}
