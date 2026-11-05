import { useState, useRef, useCallback } from 'react'
import type { ReactElement, ReactNode, CSSProperties, PointerEvent } from 'react'

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
  const modalRef = useRef<HTMLDivElement>(null)

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
      className="pdf-modal-mask"
      role={role}
      aria-label={ariaLabel}
      onClick={(e) => {
        if (e.target === e.currentTarget && onMaskClick) {
          onMaskClick()
        }
      }}
    >
      <div
        ref={modalRef}
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
