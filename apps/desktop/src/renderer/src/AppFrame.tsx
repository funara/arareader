import { useEffect, useState } from 'react'
import type { UiTheme } from '../../shared/home-api'
import { Home } from './Home'
import { TabBar } from './TabBar'

/**
 * PDF host frame: the tab strip is always painted; the home surface stays
 * mounted underneath it and is hidden while a PDF WebContentsView tab covers
 * this area from the main process.
 */
export function AppFrame({ initialTheme }: { initialTheme: UiTheme }) {
  const [homeActive, setHomeActive] = useState(true)
  const [theme, setTheme] = useState<UiTheme>(initialTheme)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => setSystemDark(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  const isDarkTheme = theme === 'dark' || (theme === 'system' && systemDark)

  const changeTheme = (next: UiTheme) => {
    setTheme(next)
    const resolved =
      next === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : next
    document.documentElement.setAttribute('data-theme', resolved)
    void window.reader.setTheme(next).catch(() => {})
  }

  const toggleTheme = () => changeTheme(isDarkTheme ? 'light' : 'dark')

  useEffect(() => {
    const applyTabs = (tabs: Awaited<ReturnType<typeof window.readerTabs.list>>) => {
      const active = tabs.find((tab) => tab.active)
      setHomeActive(!active || active.kind === 'home')
    }
    void window.readerTabs.list().then(applyTabs)
    return window.readerTabs.onChanged(applyTabs)
  }, [])

  return (
    <div className="app-frame">
      <TabBar isDarkTheme={isDarkTheme} onToggleTheme={toggleTheme} />
      <div className="app-frame-content" style={{ visibility: homeActive ? 'visible' : 'hidden' }}>
        <Home active={homeActive} />
      </div>
    </div>
  )
}
