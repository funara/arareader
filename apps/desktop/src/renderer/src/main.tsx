import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang } from '@arareader/i18n'
import { AppFrame } from './AppFrame'
import { LocaleProvider } from './locale'
import './home.css'
import './tabbar.css'

// macOS shell window is created with vibrancy; a transparent body lets the
// PDF views' translucent regions show it
if (navigator.platform.toLowerCase().includes('mac')) document.body.classList.add('vib')

// Resolve persisted state before first paint so the theme never flashes.
void Promise.all([
  window.reader.getLanguage().catch(() => 'en' as const),
  window.reader.getTheme().catch(() => 'system' as const),
]).then(([lang, theme]) => {
  document.documentElement.lang = htmlLang(lang)
  const applyResolvedTheme = (value: string) => {
    if (value === 'system') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
    } else {
      document.documentElement.setAttribute('data-theme', value)
    }
  }
  applyResolvedTheme(theme)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    void window.reader.getTheme().then((current) => {
      if (current === 'system') {
        document.documentElement.setAttribute('data-theme', event.matches ? 'dark' : 'light')
      }
    })
  })
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initial={lang}>
        <AppFrame initialTheme={theme} />
      </LocaleProvider>
    </React.StrictMode>,
  )
})
