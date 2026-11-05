import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** What Tab can land on inside an overlay, in DOM order */
const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]',
].join(',')

/**
 * Keep Tab inside a modal overlay. The command palette and the Organize grid are fixed masks
 * over the whole window, so a Tab that leaves them lands on ribbon/main-toolbar controls the
 * user cannot see. `root` is the overlay; focus wraps at its first and last reachable element.
 */
export function trapTabKey(
  e: Pick<ReactKeyboardEvent | KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>,
  root: HTMLElement | null,
): void {
  if (e.key !== 'Tab' || !root) return
  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0,
  )
  if (items.length === 0) return
  const first = items[0]!
  const last = items[items.length - 1]!
  const current = root.ownerDocument.activeElement
  if (e.shiftKey) {
    if (current === first || !root.contains(current)) {
      e.preventDefault()
      last.focus()
    }
  } else if (current === last || !root.contains(current)) {
    e.preventDefault()
    first.focus()
  }
}
