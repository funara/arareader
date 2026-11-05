import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@arareader/i18n'
import { ErrorBoundary } from '@arareader/ui'
import App from './App'
import { LocaleProvider } from './i18n/locale'
import './styles.css'
import '@arareader/ui/ai-panel.css'

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)')
const syncTheme = (): void => {
  document.documentElement.setAttribute('data-theme', darkMedia.matches ? 'dark' : 'light')
}
syncTheme()
darkMedia.addEventListener('change', syncTheme)

void (async () => {
  const lang: Lang = await window.pdfApi.getLanguage().catch(() => 'zh' as const)
  document.documentElement.lang = htmlLang(lang)
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <LocaleProvider initial={lang}>
        <App />
      </LocaleProvider>
    </ErrorBoundary>,
  )
})()
