import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { TabSummary } from '../../shared/tabs-api'
import { TAB_STRIP_HEIGHT } from '../../shared/tabs-api'
import { PdfGlyph } from './icons'
import { useI18n } from './locale'

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9.06163 4.82633L3.23911 9.92134C2.7398 10.3583 3.07458 11.1343 3.76238 11.1343C4.18259 11.1343 4.52324 11.4489 4.52324 11.8371V15.0806C4.52324 17.871 4.52324 19.2662 5.46176 20.1331C6.40029 21 7.91082 21 10.9319 21H13.0681C16.0892 21 17.5997 21 18.5382 20.1331C19.4768 19.2662 19.4768 17.871 19.4768 15.0806V11.8371C19.4768 11.4489 19.8174 11.1343 20.2376 11.1343C20.9254 11.1343 21.2602 10.3583 20.7609 9.92134L14.9383 4.82633C13.5469 3.60878 12.8512 3 12 3C11.1488 3 10.4531 3.60878 9.06163 4.82633Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 16.0011H12.0105"
        stroke="currentColor"
        strokeWidth="2.57143"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ContinuousGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5.5" y="3.5" width="13" height="4.5" rx="1" />
      <rect x="5.5" y="9.75" width="13" height="4.5" rx="1" />
      <rect x="5.5" y="16" width="13" height="4.5" rx="1" />
    </svg>
  )
}

function PagedGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="8" y="4.5" width="8" height="15" rx="1" />
      <path d="M4.5 7 H6.5 M4.5 12 H6.5 M4.5 17 H6.5" />
    </svg>
  )
}

function PageLayoutGlyph({ spread }: { spread: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {spread ? (
        <>
          <rect x="3" y="5" width="8" height="14" rx="1" />
          <rect x="13" y="5" width="8" height="14" rx="1" />
        </>
      ) : (
        <rect x="7" y="5" width="10" height="14" rx="1" />
      )}
    </svg>
  )
}

const TAB_ICON: Record<TabSummary['kind'], ReactElement> = {
  home: <HomeIcon />,
  pdf: <PdfGlyph />,
}

interface DragInfo {
  pointerId: number
  id: string
  from: number
  startX: number
  /** viewport-x left edge + width of every tab, sampled at drag start */
  lefts: number[]
  widths: number[]
  target: number
  started: boolean
}

/**
 * PDF-only tab strip. Home is pinned at index 0; PDF tabs activate, close
 * (button or middle click) and drag-reorder within the strip.
 */
export function TabBar({
  isDarkTheme,
  onToggleTheme,
}: {
  isDarkTheme: boolean
  onToggleTheme: () => void
}) {
  const { t } = useI18n()
  const [tabs, setTabs] = useState<TabSummary[]>([])
  const [maximized, setMaximized] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragInfo | null>(null)
  const [dragVisual, setDragVisual] = useState<{
    id: string
    dx: number
    from: number
    target: number
    width: number
  } | null>(null)

  const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent || navigator.platform)

  useEffect(() => {
    void window.readerTabs.list().then(setTabs)
    return window.readerTabs.onChanged(setTabs)
  }, [])

  useEffect(() => {
    if (!window.readerWindow.isWindows) return
    void window.readerWindow.isMaximized().then(setMaximized)
    return window.readerWindow.onMaximizedChanged(setMaximized)
  }, [])

  // a drag whose tab disappeared (e.g. Ctrl+W) never gets pointerup
  useEffect(() => {
    const drag = dragRef.current
    if (drag && !tabs.some((tab) => tab.id === drag.id)) {
      dragRef.current = null
      setDragVisual(null)
    }
  }, [tabs])

  const activeTab = tabs.find((tab) => tab.active)
  const activeId = activeTab?.id
  const homeTab = tabs.find((tab) => tab.kind === 'home')
  useEffect(() => {
    if (dragRef.current) return
    stripRef.current
      ?.querySelector('.tab-item.active')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId])

  const finishDrag = (pointerId: number, commit: boolean) => {
    const drag = dragRef.current
    if (!drag || pointerId !== drag.pointerId) return
    dragRef.current = null
    if (!drag.started) return
    setDragVisual(null)
    if (!commit || drag.target === drag.from) return
    // optimistic local reorder; the main-process broadcast arrives with the
    // identical order
    setTabs((prev) => {
      const fromIndex = prev.findIndex((tab) => tab.id === drag.id)
      if (fromIndex < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(Math.min(Math.max(drag.target, 1), next.length), 0, moved)
      return next
    })
    void window.readerTabs.reorder(drag.id, drag.target)
  }

  const beginDrag = (tab: TabSummary, index: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('.tab-close')) return
    if (!tab.active) void window.readerTabs.activate(tab.id)
    if (tab.kind === 'home') return
    const strip = stripRef.current
    if (!strip) return
    const rects = Array.from(strip.querySelectorAll<HTMLElement>('.tab-item'), (el) =>
      el.getBoundingClientRect(),
    )
    dragRef.current = {
      pointerId: event.pointerId,
      id: tab.id,
      from: index,
      startX: event.clientX,
      lefts: rects.map((rect) => rect.left),
      widths: rects.map((rect) => rect.width),
      target: index,
      started: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    let dx = event.clientX - drag.startX
    // 4px dead zone so plain clicks never wiggle the tab
    if (!drag.started) {
      if (Math.abs(dx) < 4) return
      // re-sample once the drag really starts (activation may have re-rendered)
      const strip = stripRef.current
      if (strip) {
        const rects = Array.from(strip.querySelectorAll<HTMLElement>('.tab-item'), (el) =>
          el.getBoundingClientRect(),
        )
        drag.lefts = rects.map((rect) => rect.left)
        drag.widths = rects.map((rect) => rect.width)
      }
      drag.started = true
    }
    // keep the dragged tab inside the strip; slot 0 (Home) is a zero-width
    // placeholder, so PDF targets start at index 1
    const last = drag.lefts.length - 1
    const minDx = drag.lefts[1] - drag.lefts[drag.from]
    const maxDx =
      drag.lefts[last] + drag.widths[last] - drag.widths[drag.from] - drag.lefts[drag.from]
    dx = Math.min(Math.max(dx, minDx), Math.max(minDx, maxDx))
    // the tab under the pointer becomes the target slot
    const pointerX = drag.lefts[drag.from] + dx + drag.widths[drag.from] / 2
    let target = 1
    for (let i = 1; i <= last; i++) {
      if (pointerX >= drag.lefts[i] + drag.widths[i] / 2) target = i
    }
    drag.target = target
    setDragVisual({ id: drag.id, dx, from: drag.from, target, width: drag.widths[drag.from] })
  }

  return (
    <div className="tab-bar" style={{ height: TAB_STRIP_HEIGHT }}>
      {/* clears the macOS traffic lights (titleBarStyle: hiddenInset) */}
      {/* The header brand occupies the same width as the sidebar, so the Home
       * tab starts exactly at the sidebar boundary, matching ARAOffice. */}
      <div className={`tab-bar-drag-spacer${isMac ? ' mac' : ''}`}>
        <img
          className="tab-brand-logo tab-brand-logo-dark"
          src="./ARAReader_dark.png"
          alt="ARAReader"
          draggable={false}
        />
        <img
          className="tab-brand-logo tab-brand-logo-light"
          src="./ARAReader_light.png"
          alt="ARAReader"
          draggable={false}
        />
        {homeTab && (
          <div className="tab-home-floating">
            <button
              type="button"
              className={`tab-item tab-home${homeTab.active ? ' active' : ''}`}
              aria-label={t('home')}
              aria-pressed={homeTab.active}
              onClick={() => void window.readerTabs.activate(homeTab.id)}
            >
              <span className="tab-plate" aria-hidden="true" />
              <span className="tab-icon">{TAB_ICON.home}</span>
              <span className="tab-title">{t('home')}</span>
            </button>
          </div>
        )}
      </div>
      <div className={`tab-strip${dragVisual ? ' dragging' : ''}`} ref={stripRef}>
        {tabs.map((tab, index) => {
          if (tab.kind === 'home') {
            return (
              <div
                key={tab.id}
                className={`tab-item tab-home tab-home-placeholder${tab.active ? ' active' : ''}`}
                aria-hidden="true"
              />
            )
          }
          let dragStyle: CSSProperties | undefined
          if (dragVisual) {
            if (dragVisual.id === tab.id) {
              dragStyle = { transform: `translateX(${dragVisual.dx}px)` }
            } else if (dragVisual.target <= index && index < dragVisual.from) {
              dragStyle = { transform: `translateX(${dragVisual.width}px)` }
            } else if (dragVisual.from < index && index <= dragVisual.target) {
              dragStyle = { transform: `translateX(-${dragVisual.width}px)` }
            }
          }
          return (
            <div
              key={tab.id}
              className={`tab-item${tab.active ? ' active' : ''}${
                dragVisual?.id === tab.id ? ' drag-source' : ''
              }`}
              style={dragStyle}
              onAuxClick={(event) => {
                if (event.button === 1 && tab.closable) {
                  event.preventDefault()
                  void window.readerTabs.close(tab.id)
                }
              }}
              onPointerDown={(event) => beginDrag(tab, index, event)}
              onPointerMove={moveDrag}
              onPointerUp={(event) => finishDrag(event.pointerId, true)}
              onPointerCancel={(event) => finishDrag(event.pointerId, false)}
              onLostPointerCapture={(event) => finishDrag(event.pointerId, false)}
            >
              {/* highlight plate behind the content — hover capsule / active surface */}
              <span className="tab-plate" aria-hidden="true" />
              <button
                type="button"
                className="tab-select"
                aria-label={tab.title}
                aria-pressed={tab.active}
                title={tab.title}
                onClick={(event) => {
                  // Pointer-down activates before a drag; keyboard clicks still activate here.
                  if (event.detail === 0) void window.readerTabs.activate(tab.id)
                }}
              >
                <span className="tab-icon">{TAB_ICON[tab.kind]}</span>
                <span className="tab-title">{tab.title}</span>
              </button>
              {tab.closable && (
                <button
                  type="button"
                  className="tab-close"
                  title={t('closeTab')}
                  aria-label={t('closeTab')}
                  onClick={(event) => {
                    event.stopPropagation()
                    void window.readerTabs.close(tab.id)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
        <button
          className="tab-new-btn"
          title={t('openPdf')}
          aria-label={t('openPdf')}
          onClick={() => void window.reader.openPdf()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 4.286v15.429M4.286 12h15.429"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="tab-actions">
        {activeTab?.kind === 'pdf' && activeTab.reading && (
          <div className="tab-view-switch" role="group" aria-label={t('viewMode')}>
            <button
              type="button"
              className={`tab-view-btn${activeTab.paged ? '' : ' active'}`}
              title={t('continuousView')}
              aria-label={t('continuousView')}
              aria-pressed={!activeTab.paged}
              onClick={() => void window.readerTabs.setViewMode(false)}
            >
              <ContinuousGlyph />
            </button>
            <button
              type="button"
              className={`tab-view-btn${activeTab.paged ? ' active' : ''}`}
              title={t('pagedView')}
              aria-label={t('pagedView')}
              aria-pressed={!!activeTab.paged}
              onClick={() => void window.readerTabs.setViewMode(true)}
            >
              <PagedGlyph />
            </button>
          </div>
        )}
        {activeTab?.kind === 'pdf' && activeTab.reading && (
          <div className="tab-view-switch" role="group" aria-label={t('pageLayout')}>
            <button
              type="button"
              className={`tab-view-btn${activeTab.spread !== 2 ? ' active' : ''}`}
              title={t('singlePage')}
              aria-label={t('singlePage')}
              aria-pressed={activeTab.spread !== 2}
              onClick={() => void window.readerTabs.setSpread(1)}
            >
              <PageLayoutGlyph spread={false} />
            </button>
            <button
              type="button"
              className={`tab-view-btn${activeTab.spread === 2 ? ' active' : ''}`}
              title={t('twoPage')}
              aria-label={t('twoPage')}
              aria-pressed={activeTab.spread === 2}
              onClick={() => void window.readerTabs.setSpread(2)}
            >
              <PageLayoutGlyph spread />
            </button>
          </div>
        )}
        {activeTab?.reading && (
          <button className="tab-exit-read" onClick={() => void window.readerTabs.exitReadMode()}>
            {t('exitReadMode')}
          </button>
        )}
        <button
          type="button"
          className="tab-theme-btn"
          onClick={onToggleTheme}
          title={isDarkTheme ? t('switchToLight') : t('switchToDark')}
          aria-label={isDarkTheme ? t('switchToLight') : t('switchToDark')}
        >
          {isDarkTheme ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          )}
        </button>
        {window.readerWindow.isWindows && (
          <div className="window-controls">
            <button
              className="window-control"
              onClick={() => void window.readerWindow.minimize()}
              aria-label={t('minimize')}
            >
              <span className="window-glyph window-glyph-minimize" />
            </button>
            <button
              className="window-control"
              onClick={() => void window.readerWindow.toggleMaximize()}
              aria-label={maximized ? t('restore') : t('maximize')}
            >
              <span
                className={`window-glyph ${maximized ? 'window-glyph-restore' : 'window-glyph-maximize'}`}
              />
            </button>
            <button
              className="window-control window-control-close"
              onClick={() => void window.readerWindow.close()}
              aria-label={t('close')}
            >
              <span className="window-glyph window-glyph-close" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
