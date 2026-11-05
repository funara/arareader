import { useEffect, useMemo, useRef, useState } from 'react'
import { LANGS, type Lang } from '@arareader/i18n'
import { useI18n } from './locale'

/** Localized language name; falls back to the code when Intl has no data for it */
export function languageLabel(code: Lang, uiLang: Lang): string {
  if (typeof Intl.DisplayNames !== 'function') return code
  try {
    return new Intl.DisplayNames([uiLang], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * Home language menu. `setLang` persists through the host (app-settings.json)
 * and re-renders every surface; labels follow the active UI language.
 */
export function LanguageMenu({ label }: { label: string }) {
  const { lang, setLang } = useI18n()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const options = useMemo(
    () => LANGS.map((code) => ({ code, name: languageLabel(code, lang) })),
    [lang],
  )
  const current = options.find((option) => option.code === lang) ?? options[0]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="language-selector-select-wrap" ref={wrapRef}>
      <button
        type="button"
        className="language-selector-btn"
        aria-label={label}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="language-selector-btn-label">{current?.name}</span>
        <svg
          className={`language-selector-chevron${open ? ' open' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <ul className="language-selector-menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <li key={option.code} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={option.code === lang}
                className={`language-selector-option${option.code === lang ? ' selected' : ''}`}
                onClick={() => {
                  setLang(option.code)
                  setOpen(false)
                }}
              >
                {option.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
