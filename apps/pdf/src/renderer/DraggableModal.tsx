import { useState, useRef, useCallback, useId, useLayoutEffect } from 'react'
import type { ReactElement, ReactNode, CSSProperties, PointerEvent } from 'react'
import { focusInitialElement, isAvailableFocusTarget, trapTabKey } from './focus-trap'

export interface DraggableModalProps {
  children: ReactNode
  className?: string
  style?: CSSProperties
  onMaskClick?: () => void
  role?: string
  ariaLabel?: string
  /** Handle selector inside modal that initiates dragging. Defaults to '.pdf-modal-title, .pdf-modal-header' */
  handleSelector?: string
}

interface ModalEntry {
  mask: HTMLDivElement
  content: HTMLDivElement
  restoreFocus: HTMLElement | null
  onEscape: () => void
  ariaHidden: string | null
  ariaModal: string | null
  inert: boolean
  isDialog: boolean
}

const modalStacks = new WeakMap<Document, ModalEntry[]>()

function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}

function setInert(element: HTMLElement, inert: boolean): void {
  if (inert) element.setAttribute('inert', '')
  else element.removeAttribute('inert')
  if ('inert' in element) element.inert = inert
}

function syncModalStack(stack: ModalEntry[]): void {
  const top = stack.at(-1)
  for (const entry of stack) {
    const isTop = entry === top
    const containsTop = !isTop && !!top && entry.mask.contains(top.mask)
    restoreAttribute(entry.mask, 'aria-hidden', isTop || containsTop ? entry.ariaHidden : 'true')
    setInert(entry.mask, !isTop && !containsTop ? true : entry.inert)
    if (entry.isDialog) {
      entry.mask.setAttribute('aria-modal', isTop ? 'true' : 'false')
    } else {
      restoreAttribute(entry.mask, 'aria-modal', entry.ariaModal)
    }
  }
}

/**
 * Universal draggable wrapper for editor modals.
 * Allows smooth repositioning by dragging the title/header bar, with pointer capture
 * and viewport clamping so modals never fly off-screen.
 */
export function DraggableModal({
  children,
  className = '',
  style,
  onMaskClick,
  role = 'dialog',
  ariaLabel,
  handleSelector = '.pdf-modal-title, .pdf-modal-header',
}: DraggableModalProps): ReactElement {
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const draggingRef = useRef(false)
  const startRef = useRef({ pointerX: 0, pointerY: 0, originX: 0, originY: 0 })
  const maskRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const titleId = `pdf-modal-title-${useId()}`
  const onMaskClickRef = useRef(onMaskClick)
  onMaskClickRef.current = onMaskClick
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  )

  useLayoutEffect(() => {
    const mask = maskRef.current
    const title = modalRef.current?.querySelector<HTMLElement>('.pdf-modal-title')
    if (!mask) return
    if (ariaLabel) {
      mask.removeAttribute('aria-labelledby')
      return
    }
    if (title) {
      if (!title.id) title.id = titleId
      mask.setAttribute('aria-labelledby', title.id)
    }
  }, [ariaLabel, titleId])

  useLayoutEffect(() => {
    const mask = maskRef.current
    const content = modalRef.current
    if (!mask || !content) return

    const doc = mask.ownerDocument
    const stack = modalStacks.get(doc) ?? []
    const previous = stack.at(-1)
    let restoreFocus = restoreFocusRef.current
    const active = doc.activeElement
    if (previous && active instanceof HTMLElement && previous.content.contains(active)) {
      restoreFocus = active
    }
    const entry: ModalEntry = {
      mask,
      content,
      restoreFocus,
      onEscape: () => onMaskClickRef.current?.(),
      ariaHidden: mask.getAttribute('aria-hidden'),
      ariaModal: mask.getAttribute('aria-modal'),
      inert: mask.inert || mask.hasAttribute('inert'),
      isDialog: role === 'dialog' || role === 'alertdialog',
    }
    stack.push(entry)
    modalStacks.set(doc, stack)
    syncModalStack(stack)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (stack.at(-1) !== entry) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        entry.onEscape()
      } else if (event.key === 'Tab') {
        trapTabKey(event, content)
      }
    }
    doc.addEventListener('keydown', onKeyDown, true)

    if (!content.contains(doc.activeElement)) focusInitialElement(content)

    return () => {
      doc.removeEventListener('keydown', onKeyDown, true)
      const index = stack.indexOf(entry)
      const wasTop = index === stack.length - 1
      if (index !== -1) {
        stack.splice(index, 1)
        for (const remaining of stack) {
          if (remaining.restoreFocus && mask.contains(remaining.restoreFocus)) {
            remaining.restoreFocus = entry.restoreFocus
          }
        }
        syncModalStack(stack)
        if (stack.length === 0) modalStacks.delete(doc)
      }
      restoreAttribute(mask, 'aria-hidden', entry.ariaHidden)
      restoreAttribute(mask, 'aria-modal', entry.ariaModal)
      setInert(mask, entry.inert)

      if (wasTop) {
        const nextTop = stack.at(-1)
        const target = entry.restoreFocus
        if (target && isAvailableFocusTarget(target)) target.focus()
        else if (nextTop) focusInitialElement(nextTop.content)
      }
    }
  }, [role])

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return // left click only
      const target = e.target as HTMLElement | null
      if (!target) return
      const handle = target.closest(handleSelector)
      if (!handle) return
      // Never initiate drag when clicking interactive elements within the title area
      if (target.closest('button, input, textarea, select, a, [role="button"]')) return

      draggingRef.current = true
      setIsDragging(true)
      startRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        originX: offset.x,
        originY: offset.y,
      }
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // pointer capture fallback
      }
    },
    [handleSelector, offset],
  )

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      const dx = e.clientX - startRef.current.pointerX
      const dy = e.clientY - startRef.current.pointerY
      const newX = startRef.current.originX + dx
      const newY = startRef.current.originY + dy

      // Safe viewport boundary clamping
      const viewportW = window.innerWidth
      const viewportH = window.innerHeight
      const modalEl = modalRef.current
      let clampedX = newX
      let clampedY = newY
      if (modalEl) {
        const rect = modalEl.getBoundingClientRect()
        const initialLeft = rect.left - offset.x
        const initialTop = rect.top - offset.y
        // Keep at least 60px of the header/modal inside the screen
        const minX = -initialLeft + 60 - rect.width
        const maxX = viewportW - initialLeft - 60
        const minY = -initialTop + 10
        const maxY = viewportH - initialTop - 40
        clampedX = Math.min(Math.max(newX, minX), maxX)
        clampedY = Math.min(Math.max(newY, minY), maxY)
      }

      setOffset({ x: clampedX, y: clampedY })
    },
    [offset],
  )

  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) {
      draggingRef.current = false
      setIsDragging(false)
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
      } catch {
        // ignore
      }
    }
  }, [])

  return (
    <div
      ref={maskRef}
      className="pdf-modal-mask"
      role={role}
      aria-label={ariaLabel || 'Dialog'}
      aria-modal={role === 'dialog' || role === 'alertdialog' ? true : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget && onMaskClick) {
          onMaskClick()
        }
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className={`pdf-modal is-draggable${isDragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
        style={{
          transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
          ...style,
        }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {children}
      </div>
    </div>
  )
}
