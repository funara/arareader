import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { trapTabKey } from './focus-trap'
import { t } from './i18n/locale'

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  run: () => void
  disabled?: boolean
}

/** Row cap: the palette is a launcher, deep lists scroll the ribbons instead */
const MAX_ROWS = 12

/**
 * Keyboard-first command launcher (Ctrl/Cmd+K). Pure presentation: App owns the command
 * list and whatever each command does, this file owns filtering, the active row and the
 * keyboard contract. Mounted only while open, so query/active state resets naturally —
 * the reset effect also covers App re-opening without unmounting.
 */
export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean
  commands: PaletteCommand[]
  onClose: () => void
}): ReactElement | null {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const maskRef = useRef<HTMLDivElement>(null)

  // Opening always starts from a clean slate and takes focus
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    inputRef.current?.focus()
  }, [open])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) || (c.hint ? c.hint.toLowerCase().includes(q) : false),
    )
  }, [commands, query])
  const rows = matches.slice(0, MAX_ROWS)

  // Filtering moves the highlight back to the top match
  useEffect(() => {
    setActive(0)
  }, [query])

  /** First row from `from` in `dir` that can actually run; -1 when there is none */
  const seek = (dir: 1 | -1, from: number): number => {
    for (let i = from; i >= 0 && i < rows.length; i += dir) {
      const row = rows[i]
      if (row && !row.disabled) return i
    }
    return -1
  }
  // A disabled row must never be the highlight: most documents open clean, where the first
  // command (Save) is disabled, and Enter on a disabled row is a no-op.
  const stored = rows[active]
  const activeIdx = stored && !stored.disabled ? active : seek(1, 0)
  const activeRow = activeIdx >= 0 ? rows[activeIdx] : undefined

  if (!open) return null

  const runRow = (row: PaletteCommand | undefined): void => {
    if (!row || row.disabled) return
    onClose()
    row.run()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = seek(1, activeIdx + 1)
      if (next >= 0) setActive(next)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = seek(-1, activeIdx - 1)
      if (next >= 0) setActive(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runRow(activeRow)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // App's window handler also closes the palette; stop it from closing anything behind it
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      ref={maskRef}
      className="pdf-palette-mask"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      // The mask covers the ribbon: Tab must stay in the dialog, not walk the hidden controls
      onKeyDown={(e) => trapTabKey(e, maskRef.current)}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="pdf-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('commandPalette')}
        style={{
          width: 'min(560px, calc(100vw - 24px))',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="pdf-palette-input"
          type="text"
          role="combobox"
          aria-expanded={activeRow !== undefined}
          aria-controls="pdf-palette-list"
          aria-autocomplete="list"
          aria-activedescendant={activeRow ? `pdf-palette-opt-${activeRow.id}` : undefined}
          value={query}
          placeholder={t('commandPlaceholder')}
          aria-label={t('commandPalette')}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div
          id="pdf-palette-list"
          className="pdf-palette-list"
          role="listbox"
          aria-label={t('commandPalette')}
          style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', maxHeight: '50vh' }}
        >
          {rows.map((c, i) => (
            <button
              key={c.id}
              id={`pdf-palette-opt-${c.id}`}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              // True match count, so "3 of 41" stays honest when the list is capped
              aria-posinset={i + 1}
              aria-setsize={matches.length}
              // Combobox pattern: focus stays in the input, the active row is announced
              tabIndex={-1}
              className={`pdf-palette-row${i === activeIdx ? ' pdf-palette-active' : ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                width: '100%',
                textAlign: 'left',
              }}
              title={c.hint ? `${c.label} — ${c.hint}` : c.label}
              disabled={c.disabled}
              onMouseEnter={() => {
                if (!c.disabled) setActive(i)
              }}
              // mousedown would steal focus from the input mid-typing
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runRow(c)}
            >
              <span className="pdf-palette-label">{c.label}</span>
              {c.hint && <span className="pdf-palette-hint">{c.hint}</span>}
            </button>
          ))}
          {rows.length === 0 && (
            <div className="pdf-palette-empty" role="presentation">
              {t('searchNoResults')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
