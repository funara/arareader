import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { trapTabKey } from './focus-trap'
import type { TFunc } from './i18n/locale'

/** Raster width of a grid thumbnail, in CSS px; the card stretches it to its column width */
const THUMB_W = 160

/** Thumbnail canvas for one grid card: renders only when visible, keeps the bitmap while
 *  offscreen, and cancels its render task on unmount (mirrors the sidebar PdfThumb). */
function OrganizeThumb({
  doc,
  pageNo,
  rotationDelta,
  visible,
}: {
  doc: PDFDocumentProxy
  pageNo: number
  rotationDelta: number
  visible: boolean
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const renderedKeyRef = useRef<string | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // A saved/reloaded document invalidates every cached page bitmap
    if (docRef.current !== doc) {
      docRef.current = doc
      renderedKeyRef.current = null
      setReady(false)
    }
    if (!visible) return
    const key = `${pageNo}:${rotationDelta}`
    if (renderedKeyRef.current === key) {
      setReady(true)
      return
    }
    // New page/rotation: drop the stale bitmap behind the placeholder until the render lands
    setReady(false)
    let cancelled = false
    let renderTask: RenderTask | null = null
    void (async () => {
      const page = await doc.getPage(pageNo)
      if (cancelled) return
      const rotation = (page.rotate + rotationDelta) % 360
      const scale = THUMB_W / page.getViewport({ scale: 1, rotation }).width
      const viewport = page.getViewport({ scale, rotation })
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      renderTask = page.render({
        canvas,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      })
      try {
        await renderTask.promise
      } catch {
        return // cancelled
      }
      if (cancelled) return
      renderedKeyRef.current = key
      setReady(true)
    })()
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, pageNo, rotationDelta, visible])
  return (
    <>
      {(!visible || !ready) && (
        <span
          className="pdf-organize-placeholder"
          aria-hidden
          style={{ display: 'block', width: '100%', aspectRatio: '210 / 297' }}
        />
      )}
      <canvas
        ref={canvasRef}
        style={{ display: visible && ready ? 'block' : 'none', width: '100%' }}
      />
    </>
  )
}

/**
 * Full-window Organize Pages grid: one card per visible page with multi-select, rotation and
 * the pending page operations. Selection semantics live here; what each action does (undo
 * snapshots, pending deletes, file writes) stays in App.
 */
export function OrganizeGrid({
  doc,
  visList,
  rotDelta,
  selected,
  onSelect,
  onClose,
  onRotate,
  onDelete,
  onInsertBlank,
  onDuplicate,
  readOnly,
  t,
  actionsDisabled = false,
  currentOrigIdx,
  error = '',
}: {
  doc: PDFDocumentProxy
  /** display order: original page indices */
  visList: number[]
  rotDelta: (origIdx: number) => number
  selected: ReadonlySet<number>
  onSelect: (next: Set<number>) => void
  onClose: () => void
  onRotate: (origIdx: number, dir: 90 | -90) => void
  onDelete: (origIndices: number[]) => void
  onInsertBlank: (afterOrigIdx: number) => void
  onDuplicate: (origIndices: number[]) => void
  readOnly: boolean
  t: TFunc
  /** Immediate file writes are unavailable while the file's pages still differ from
   *  the pending `deleted`/`order` state (the grid is then view/select only) */
  actionsDisabled?: boolean
  /** Original index of the page the reader is on; Insert blank falls back to it */
  currentOrigIdx?: number
  /** Last file-write failure; the grid covers the status bar that would show it */
  error?: string
}): ReactElement {
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** Last plain/Ctrl-clicked card position, the Shift-click range anchor */
  const anchorRef = useRef<number | null>(null)
  const [visible, setVisible] = useState<Set<number>>(new Set())
  const count = visList.length

  // The grid is modal and covers the ribbon, so it takes focus on open: Tab then walks its own
  // controls instead of the hidden ones behind it
  useEffect(() => {
    scrollRef.current?.focus()
  }, [])

  // Lazy thumbnails: observe cards against the grid's own scroll root
  useEffect(() => {
    const root = scrollRef.current
    if (!root || count === 0) return
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev)
          for (const e of entries) {
            const idx = Number((e.target as HTMLElement).dataset.idx)
            if (e.isIntersecting) next.add(idx)
            else next.delete(idx)
          }
          return next
        })
      },
      { root, rootMargin: '240px' },
    )
    for (const el of cardRefs.current) if (el) io.observe(el)
    return () => io.disconnect()
  }, [count])

  const setCardRef = (idx: number) => (el: HTMLButtonElement | null) => {
    cardRefs.current[idx] = el
  }

  const selectedOrig = visList.filter((origIdx) => selected.has(origIdx))
  const hasSelection = selectedOrig.length > 0
  /** Insert blank goes after the last selected page, else after the reader's current page */
  const insertAnchor =
    selectedOrig.length > 0 ? selectedOrig[selectedOrig.length - 1] : (currentOrigIdx ?? -1)

  const onCardClick = (e: React.MouseEvent<HTMLButtonElement>, pos: number, origIdx: number) => {
    if (readOnly) return
    if (e.shiftKey) {
      const anchor = anchorRef.current
      if (anchor === null) {
        anchorRef.current = pos
        onSelect(new Set([origIdx]))
        return
      }
      const lo = Math.min(anchor, pos)
      const hi = Math.max(anchor, pos)
      onSelect(new Set(visList.slice(lo, hi + 1)))
      return
    }
    anchorRef.current = pos
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(origIdx)) next.delete(origIdx)
      else next.add(origIdx)
      onSelect(next)
      return
    }
    onSelect(new Set([origIdx]))
  }

  const rotateSelected = (dir: 90 | -90): void => {
    for (const origIdx of selectedOrig) onRotate(origIdx, dir)
  }

  return (
    <div
      ref={gridRef}
      className="pdf-organize-grid"
      role="dialog"
      aria-modal="true"
      aria-label={t('organizePages')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--canvas)',
      }}
      onKeyDown={(e) => trapTabKey(e, gridRef.current)}
    >
      <div
        className="pdf-organize-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
        }}
      >
        <span className="pdf-organize-title" style={{ fontWeight: 600 }}>
          {t('organizePages')}
        </span>
        <span className="pdf-organize-count" style={{ color: 'var(--text-dim)' }}>
          {t('selectedCount', { n: selected.size })}
        </span>
        <span
          className="pdf-organize-actions"
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}
        >
          <button
            type="button"
            className="pdf-modal-btn"
            title={t('rotateLeft')}
            aria-label={t('rotateLeft')}
            disabled={readOnly || !hasSelection}
            onClick={() => rotateSelected(-90)}
          >
            ↺
          </button>
          <button
            type="button"
            className="pdf-modal-btn"
            title={t('rotateRight')}
            aria-label={t('rotateRight')}
            disabled={readOnly || !hasSelection}
            onClick={() => rotateSelected(90)}
          >
            ↻
          </button>
          <button
            type="button"
            className="pdf-modal-btn"
            title={t('insertBlankPage')}
            disabled={readOnly || actionsDisabled}
            onClick={() => onInsertBlank(insertAnchor)}
          >
            {t('insertBlankPage')}
          </button>
          <button
            type="button"
            className="pdf-modal-btn"
            title={t('duplicatePage')}
            disabled={readOnly || actionsDisabled || !hasSelection}
            onClick={() => onDuplicate(selectedOrig)}
          >
            {t('duplicatePage')}
          </button>
          <button
            type="button"
            className="pdf-modal-btn"
            title={t('deletePage')}
            disabled={readOnly || !hasSelection}
            onClick={() => onDelete(selectedOrig)}
          >
            {t('deletePage')}
          </button>
          <button
            type="button"
            className="pdf-organize-close pdf-modal-btn"
            title={t('cancel')}
            aria-label={t('cancel')}
            onClick={onClose}
            style={{ marginLeft: 4 }}
          >
            ✕
          </button>
        </span>
        {error && (
          <span
            className="pdf-organize-error"
            role="alert"
            style={{ flexBasis: '100%', fontSize: 12, color: 'var(--danger)' }}
          >
            {error}
          </span>
        )}
      </div>
      <div
        ref={scrollRef}
        className="pdf-organize-scroll"
        // Focus target on mount: a container, so no page is pre-selected by opening the grid
        tabIndex={-1}
        role="group"
        aria-label={t('organizePages')}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 16,
          outline: 'none',
        }}
      >
        <div
          className="pdf-organize-cards"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${THUMB_W}px, 1fr))`,
            gap: 12,
          }}
        >
          {visList.map((origIdx, v) => {
            const isSelected = selected.has(origIdx)
            return (
              <button
                key={origIdx}
                type="button"
                ref={setCardRef(v)}
                data-idx={v}
                data-orig-idx={origIdx}
                className={`pdf-organize-card${isSelected ? ' pdf-organize-card-active' : ''}`}
                disabled={readOnly}
                title={t('appPageOf', { current: v + 1, total: count })}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                  padding: 8,
                  background: 'var(--surface)',
                  border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 8,
                  boxShadow: isSelected ? '0 0 0 2px var(--accent)' : 'none',
                  cursor: readOnly ? 'default' : 'pointer',
                }}
                onClick={(e) => onCardClick(e, v, origIdx)}
              >
                <span
                  className="pdf-organize-thumb"
                  style={{ display: 'block', width: '100%', lineHeight: 0 }}
                >
                  <OrganizeThumb
                    doc={doc}
                    pageNo={origIdx + 1}
                    rotationDelta={rotDelta(origIdx)}
                    visible={visible.has(v)}
                  />
                </span>
                <span className="pdf-organize-no" style={{ color: 'var(--text-muted)' }}>
                  {v + 1}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
