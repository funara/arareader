import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** What Tab can land on inside an overlay, in DOM order */
const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not(:disabled)',
  'input:not([type="hidden"]):not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',')

/** A candidate must be rendered and outside hidden, inert, or disabled content. */
export function isAvailableFocusTarget(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(':disabled')) return false
  const view = element.ownerDocument.defaultView
  if (!view) return false
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hidden ||
      current.inert ||
      current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden') === 'true'
    ) {
      return false
    }
    const style = view.getComputedStyle(current)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false
    }
  }
  return true
}

/** Focusable elements in DOM order, excluding controls that are disabled or not rendered. */
export function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && isAvailableFocusTarget(element),
  )
}

/** Initial focus respects an existing `autoFocus` target before falling back to DOM order. */
export function focusInitialElement(root: HTMLElement): void {
  const items = getFocusableElements(root)
  const target = items.find((item) => item.hasAttribute('autofocus')) ?? items[0] ?? root
  target.focus()
}

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
  const items = getFocusableElements(root)
  if (items.length === 0) {
    e.preventDefault()
    root.focus()
    return
  }
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
