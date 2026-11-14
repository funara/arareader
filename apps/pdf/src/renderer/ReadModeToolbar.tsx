import { useEffect, useRef, useState } from 'react'
import type { TFunc } from './i18n/locale'

type Menu = 'zoom' | 'view' | null

export function ReadModeToolbar({
  page,
  pageCount,
  scale,
  viewMode,
  spread,
  onPage,
  onStep,
  onZoomIn,
  onZoomOut,
  onFit,
  onViewMode,
  onSpread,
  onExit,
  t,
}: {
  page: number
  pageCount: number
  scale: number
  viewMode: 'continuous' | 'paged'
  spread: 1 | 2
  onPage: (page: number) => void
  onStep: (direction: -1 | 1) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: (mode: 'width' | 'page') => void
  onViewMode: (mode: 'continuous' | 'paged') => void
  onSpread: (spread: 1 | 2) => void
  onExit: () => void
  t: TFunc
}) {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<Menu>(null)
  const hoveredRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [visible, setVisible] = useState(true)
  const [menu, setMenu] = useState<Menu>(null)
  const [pageInput, setPageInput] = useState(String(page))
  menuRef.current = menu

  useEffect(() => setPageInput(String(page)), [page])

  useEffect(() => {
    let lastPointer: { x: number; y: number } | undefined
    const reveal = () => {
      setVisible(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        if (
          !hoveredRef.current &&
          !menuRef.current &&
          !toolbarRef.current?.contains(document.activeElement)
        ) {
          setVisible(false)
        }
      }, 2500)
    }
    const move = (event: PointerEvent) => {
      if (lastPointer?.x === event.clientX && lastPointer.y === event.clientY) return
      lastPointer = { x: event.clientX, y: event.clientY }
      reveal()
    }
    const pointerDown = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) setMenu(null)
      reveal()
    }
    const keyDown = (event: KeyboardEvent) => {
      reveal()
      if (event.key === 'Escape' && menuRef.current) {
        event.preventDefault()
        event.stopImmediatePropagation()
        toolbarRef.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus()
        setMenu(null)
      }
    }
    reveal()
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', pointerDown)
    window.addEventListener('keydown', keyDown, true)
    window.addEventListener('wheel', reveal, { passive: true })
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', pointerDown)
      window.removeEventListener('keydown', keyDown, true)
      window.removeEventListener('wheel', reveal)
    }
  }, [])

  const resumeHide = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      if (
        !hoveredRef.current &&
        !menuRef.current &&
        !toolbarRef.current?.contains(document.activeElement)
      ) {
        setVisible(false)
      }
    }, 2500)
  }
  const commitPage = () => {
    if (/^\d+$/.test(pageInput)) {
      const next = Math.min(pageCount, Math.max(1, Number(pageInput)))
      onPage(next)
      setPageInput(String(next))
    } else setPageInput(String(page))
  }

  return (
    <div
      ref={toolbarRef}
      className={`read-toolbar${visible ? '' : ' is-hidden'}`}
      role="group"
      aria-label={t('readMode')}
      onPointerEnter={() => {
        hoveredRef.current = true
        setVisible(true)
      }}
      onPointerLeave={() => {
        hoveredRef.current = false
        resumeHide()
      }}
      onFocus={() => setVisible(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resumeHide()
      }}
    >
      <div className="read-toolbar-group">
        <button
          type="button"
          title={t('searchPrev')}
          aria-label={t('searchPrev')}
          disabled={page <= spread}
          onClick={() => onStep(-1)}
        >
          ‹
        </button>
        <input
          aria-label={t('appPageOf', { current: page, total: pageCount })}
          inputMode="numeric"
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={commitPage}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <span className="read-toolbar-total">/ {pageCount}</span>
        <button
          type="button"
          title={t('searchNext')}
          aria-label={t('searchNext')}
          disabled={Math.floor((page - 1) / spread) >= Math.floor((pageCount - 1) / spread)}
          onClick={() => onStep(1)}
        >
          ›
        </button>
      </div>
      <div className="read-toolbar-group">
        <button type="button" title={t('zoomOut')} aria-label={t('zoomOut')} onClick={onZoomOut}>
          −
        </button>
        <div className="read-toolbar-popup-anchor">
          <button
            type="button"
            className="read-toolbar-text"
            aria-expanded={menu === 'zoom'}
            onClick={() => setMenu(menu === 'zoom' ? null : 'zoom')}
          >
            {Math.round(scale * 100)}% ▾
          </button>
          {menu === 'zoom' && (
            <div className="read-toolbar-popup" role="group" aria-label={t('viewMode')}>
              <button
                type="button"
                onClick={() => {
                  onFit('page')
                  setMenu(null)
                }}
              >
                {t('fitPage')}
              </button>
              <button
                type="button"
                onClick={() => {
                  onFit('width')
                  setMenu(null)
                }}
              >
                {t('fitWidth')}
              </button>
            </div>
          )}
        </div>
        <button type="button" title={t('zoomIn')} aria-label={t('zoomIn')} onClick={onZoomIn}>
          +
        </button>
      </div>
      <div className="read-toolbar-popup-anchor">
        <button
          type="button"
          className="read-toolbar-text"
          aria-expanded={menu === 'view'}
          onClick={() => setMenu(menu === 'view' ? null : 'view')}
        >
          {t('viewMode')} ▾
        </button>
        {menu === 'view' && (
          <div className="read-toolbar-popup" role="group" aria-label={t('viewMode')}>
            <button
              type="button"
              aria-pressed={viewMode === 'continuous'}
              onClick={() => onViewMode('continuous')}
            >
              {t('continuousView')}
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'paged'}
              onClick={() => onViewMode('paged')}
            >
              {t('pagedView')}
            </button>
            <hr />
            <button type="button" aria-pressed={spread === 1} onClick={() => onSpread(1)}>
              {t('singlePage')}
            </button>
            <button type="button" aria-pressed={spread === 2} onClick={() => onSpread(2)}>
              {t('twoPage')}
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className="read-toolbar-exit"
        title={t('exitReadMode')}
        aria-label={t('exitReadMode')}
        onClick={onExit}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )
}
