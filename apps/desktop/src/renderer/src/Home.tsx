import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiSettings } from '@arareader/ai-provider'
import type { ReaderPreferences, RecentEntry } from '../../shared/home-api'
import type { AppUpdateState } from '../../shared/update-api'
import { AboutModal } from './AboutModal'
import { ChangelogModal } from './ChangelogModal'
import { PdfGlyph } from './icons'
import { LanguageMenu } from './LanguageMenu'
import { useI18n } from './locale'
import { ProviderModal, type SettingsSection } from './ProviderModal'
import { UpdateRestartModal } from './UpdateRestartModal'
import { OnboardingModal } from './OnboardingModal'

const REPO_URL = 'https://github.com/funara/arareader'
const INSTAGRAM_URL = 'https://instagram.com/araoffice_ai'
const WEBSITE_URL = 'https://adhirahmadian.id'

const DAILY_PROMPTS = [
  'What are we reading today?',
  'What document are we reviewing today?',
  'What are we signing today?',
  'What insights are we uncovering today?',
  'What paper are we exploring today?',
  'What are we annotating today?',
] as const

function timeGreeting(now = new Date()): string {
  const hour = now.getHours()
  if (hour >= 5 && hour < 12) return 'Good Morning'
  if (hour >= 12 && hour < 17) return 'Good Afternoon'
  return 'Good Evening'
}

function parentDir(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return index > 0 ? filePath.slice(0, index) : filePath
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatDate(mtimeMs: number, locale: string): string {
  return new Date(mtimeMs).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

interface AiStatus {
  connected: boolean
  /** model the active provider is set to ('' until settings load) */
  model: string
}

/**
 * Home's view of the AI settings: Google counts as configured once a key is
 * stored, an OpenAI-compatible endpoint once a base URL is set. Reads are
 * redacted, so this only ever sees hasApiKey.
 */
function aiStatusOf(settings: AiSettings | null): AiStatus {
  if (!settings) return { connected: false, model: '' }
  if (settings.provider === 'custom') {
    const custom = settings.providers.custom
    return { connected: Boolean(custom.baseUrl?.trim()), model: custom.model.trim() }
  }
  const google = settings.providers.google
  return { connected: Boolean(google.hasApiKey), model: google.model.trim() }
}

function HomeGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9.06 4.83 3.24 9.92c-.5.44-.16 1.21.52 1.21.42 0 .76.32.76.7v3.25c0 2.79 0 4.18.94 5.05S7.91 21 10.93 21h2.14c3.02 0 4.53 0 5.47-.87s.94-2.26.94-5.05v-3.24c0-.39.34-.7.76-.7.69 0 1.02-.78.52-1.22l-5.82-5.09C13.55 3.61 12.85 3 12 3s-1.55.61-2.94 1.83Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 16h.01"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StarGlyph({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function GlobeGlyph() {
  return (
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
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      <path d="M2 12h20" />
    </svg>
  )
}

function InfoGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

function GithubGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.3 11.3 0 0 0-3.6 22c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.4-1.3-5.4-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C16.9 4.7 18 5 18 5c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.4 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.3 11.3 0 0 0 12 .7Z" />
    </svg>
  )
}

function SettingsGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

/**
 * PDF-only home: a permanent left rail (navigation, brand/socials/settings)
 * and the main workspace (personalized greeting, Open/New PDF, and Recent/Starred table).
 */
export function Home({ active }: { active: boolean }) {
  const { t, dateLocale } = useI18n()
  const [entries, setEntries] = useState<RecentEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [newPdfError, setNewPdfError] = useState<string | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [section, setSection] = useState<'home' | 'starred'>('home')
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null)
  const [aiMenuOpen, setAiMenuOpen] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsSection>('profile')
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [userName, setUserName] = useState('Reader')
  const [starredPaths, setStarredPaths] = useState<string[]>([])
  const prefsRef = useRef<ReaderPreferences | null>(null)
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    status: 'idle',
    currentVersion: '',
  })
  const [showChangelog, setShowChangelog] = useState(false)
  const [showUpdateRestart, setShowUpdateRestart] = useState(false)
  const [onboardOpen, setOnboardOpen] = useState(false)
  const skippedInSessionRef = useRef(false)

  // Stable randomized prompt per session
  const dailyPrompt = useMemo(
    () => DAILY_PROMPTS[Math.floor(Math.random() * DAILY_PROMPTS.length)] ?? DAILY_PROMPTS[0],
    [],
  )
  const greetingPrefix = useMemo(() => timeGreeting(), [])

  // Focus search input on Cmd+F / Ctrl+F
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const applyPrefs = useCallback((prefs: ReaderPreferences | null) => {
    if (!prefs) return
    // If skipped in this session, keep session state and do not reopen modal
    if (skippedInSessionRef.current) return

    prefsRef.current = prefs
    setUserName(prefs.profile?.displayName?.trim() || 'Reader')
    setStarredPaths(Array.isArray(prefs.starredPaths) ? prefs.starredPaths : [])

    const dn = prefs.profile?.displayName?.trim() ?? ''
    const fn = prefs.profile?.fullName?.trim() ?? ''
    const hasCustomName =
      (dn.length > 0 && dn !== 'Reader' && dn !== 'ARAReader') ||
      (fn.length > 0 && fn !== 'ARAReader')

    // Show onboarding if Display Name and Full Name are missing (blank, default, or skipped)
    // or if onboarding was never completed.
    if (!hasCustomName || !prefs.onboardingCompleted) {
      setOnboardOpen(true)
    }
  }, [])

  const handleSaveOnboarding = useCallback(
    async (displayName: string, fullName: string, useAsDefaultAuthor: boolean) => {
      setOnboardOpen(false)
      const current = prefsRef.current ?? {
        profile: {
          displayName: '',
          fullName: '',
          title: '',
          organization: '',
          email: '',
          useAsDefaultAuthor: true,
        },
        signatures: [],
        starredPaths: [],
        defaultZoom: 'fit-width' as const,
        defaultSidebar: 'none' as const,
        autosave: false,
        aiAutoSuggestions: true,
      }
      const dn = displayName.trim() || fullName.trim() || 'ARAReader'
      const fn = fullName.trim() || dn || 'ARAReader'
      const next: ReaderPreferences = {
        ...current,
        profile: {
          ...current.profile,
          displayName: dn,
          fullName: fn,
          useAsDefaultAuthor,
        },
        onboardingCompleted: true,
      }
      prefsRef.current = next
      setUserName(next.profile.displayName)
      if (window.reader.setPreferences) {
        try {
          await window.reader.setPreferences(next)
        } catch {
          // ignore
        }
      }
      if (window.readerAi?.getSettings) {
        window.readerAi
          .getSettings()
          .then(setAiSettings)
          .catch(() => {})
      }
    },
    [],
  )

  const handleSkipOnboarding = useCallback(() => {
    skippedInSessionRef.current = true
    setOnboardOpen(false)
    const current = prefsRef.current ?? {
      profile: {
        displayName: 'ARAReader',
        fullName: 'ARAReader',
        title: '',
        organization: '',
        email: '',
        useAsDefaultAuthor: true,
      },
      signatures: [],
      starredPaths: [],
      defaultZoom: 'fit-width' as const,
      defaultSidebar: 'none' as const,
      autosave: false,
      aiAutoSuggestions: true,
    }
    const next: ReaderPreferences = {
      ...current,
      profile: {
        ...current.profile,
        displayName: 'ARAReader',
        fullName: 'ARAReader',
        useAsDefaultAuthor: true,
      },
      onboardingCompleted: false,
    }
    prefsRef.current = next
    setUserName('ARAReader')
  }, [])

  const refreshAi = useCallback(() => {
    void window.readerAi
      .getSettings()
      .then(setAiSettings)
      .catch(() => {})
    if (window.reader.getPreferences) {
      void window.reader
        .getPreferences()
        .then(applyPrefs)
        .catch(() => {})
    }
  }, [applyPrefs])

  useEffect(() => {
    refreshAi()
    const offSettings = window.readerAi.onSettingsChanged(setAiSettings)
    const offPrefs = window.reader.onPreferencesChanged
      ? window.reader.onPreferencesChanged(applyPrefs)
      : () => {}
    return () => {
      offSettings()
      offPrefs()
    }
  }, [refreshAi, applyPrefs])

  // A PDF view's "configure AI" card lands here: main activates Home and sends
  // this request, so the host opens Settings on the AI tab.
  useEffect(() => {
    return window.readerAi.onConfigureRequest(() => {
      setSettingsInitialTab('ai')
      setAiMenuOpen(true)
    })
  }, [])

  useEffect(() => {
    void window.reader.getAppVersion().then(setAppVersion)
  }, [])

  useEffect(() => {
    void window.reader.getUpdateState().then((state) => {
      if (state) setUpdateState(state)
    })
    void window.reader.getJustUpdated().then((justUpdated) => {
      if (!justUpdated) return
      setShowChangelog(true)
      void window.reader.clearJustUpdated()
    })
    const unsubscribe = window.reader.onUpdateStateChanged((state) => {
      setUpdateState(state)
      if (state.status === 'downloaded') {
        setShowChangelog(false)
        setShowUpdateRestart(true)
      }
    })
    return () => unsubscribe()
  }, [])

  useEffect(() => {
    if (!active) return
    let canceled = false
    void window.reader
      .recents()
      .then((page) => {
        if (canceled) return
        setEntries(page.entries)
        setTotal(page.total)
        setLoaded(true)
      })
      .catch(() => {
        if (!canceled) setLoaded(true)
      })
    return () => {
      canceled = true
    }
  }, [active])

  const removeEntry = (path: string) => {
    setEntries((prev) => prev.filter((entry) => entry.path !== path))
    setTotal((prev) => Math.max(0, prev - 1))
    void window.reader.removeRecent([path])
  }

  const toggleStar = (path: string) => {
    const isStarred = starredPaths.includes(path)
    const nextStarred = isStarred ? starredPaths.filter((p) => p !== path) : [path, ...starredPaths]
    setStarredPaths(nextStarred)
    if (window.reader.setPreferences && prefsRef.current) {
      void window.reader
        .setPreferences({
          ...prefsRef.current,
          starredPaths: nextStarred,
        })
        .then(applyPrefs)
        .catch(() => {})
    }
  }

  const createPdf = () => {
    setNewPdfError(null)
    void window.reader
      .newPdf()
      .then((result) => {
        if (!result.ok) setNewPdfError(t('newPdfFailed', { error: result.error }))
      })
      .catch((error: unknown) => {
        setNewPdfError(
          t('newPdfFailed', { error: error instanceof Error ? error.message : String(error) }),
        )
      })
  }

  const openSettingsAt = (tab: SettingsSection) => {
    setSettingsInitialTab(tab)
    setAiMenuOpen(true)
  }

  const openUrl = (url: string) => {
    void window.readerWindow.openExternal(url).catch(() => {})
  }

  const aiStatus = aiStatusOf(aiSettings)
  const aiLabel = aiStatus.connected && aiStatus.model ? aiStatus.model : 'Set up AI'

  const baseEntries = useMemo(
    () =>
      section === 'starred'
        ? entries.filter((entry) => starredPaths.includes(entry.path))
        : entries,
    [entries, section, starredPaths],
  )

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return baseEntries
    return baseEntries.filter(
      (entry) => entry.name.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q),
    )
  }, [baseEntries, searchQuery])

  const starredInListCount = useMemo(
    () => entries.filter((e) => starredPaths.includes(e.path)).length,
    [entries, starredPaths],
  )

  const updatePending =
    updateState.status === 'available' ||
    updateState.status === 'downloading' ||
    updateState.status === 'downloaded'
  const versionTitle =
    updateState.status === 'downloaded'
      ? 'Update ready to install'
      : updateState.status === 'downloading'
        ? `Downloading update (${updateState.percent ?? 0}%)…`
        : updateState.status === 'available'
          ? 'Update available'
          : 'Changelog'

  const restartNow = () => {
    void window.reader.restartAndInstall()
  }

  return (
    <div className="home">
      <aside className="sidebar">
        <nav className="sidebar-nav" aria-label={t('home')}>
          <button
            type="button"
            className={`nav-item${section === 'home' ? ' active' : ''}`}
            aria-current={section === 'home' ? 'page' : undefined}
            onClick={() => setSection('home')}
          >
            <HomeGlyph />
            <span className="nav-label">{t('home')}</span>
            {total > 0 && <span className="nav-count">{total}</span>}
          </button>
          <button
            type="button"
            className={`nav-item${section === 'starred' ? ' active' : ''}`}
            aria-current={section === 'starred' ? 'page' : undefined}
            onClick={() => setSection('starred')}
          >
            <StarGlyph filled={section === 'starred'} />
            <span className="nav-label">Starred</span>
            <span className="nav-count">{starredInListCount}</span>
          </button>
        </nav>

        <div className="sidebar-divider" />

        <div className="sidebar-about">
          <div className="sidebar-brand-row">
            <div className="sidebar-brand-left">
              <button
                type="button"
                className="sidebar-brand"
                onClick={() => setAboutOpen(true)}
                title={t('aboutTitle')}
              >
                ARAReader
              </button>
              <button
                type="button"
                className={`sidebar-version-btn${updatePending ? ' has-update' : ''}`}
                onClick={() => {
                  if (updateState.status === 'downloaded') setShowUpdateRestart(true)
                  else setShowChangelog(true)
                }}
                title={versionTitle}
                aria-label={`${t('versionLabel')}: v${appVersion || '0.2.2'}`}
              >
                <span>v{appVersion || '0.2.2'}</span>
                {updatePending && (
                  <span
                    className={`version-pulse-dot ${
                      updateState.status === 'downloading'
                        ? 'downloading'
                        : updateState.status === 'downloaded'
                          ? 'ready'
                          : 'available'
                    }`}
                  />
                )}
              </button>
            </div>
            <button
              type="button"
              className="sidebar-feedback-btn"
              onClick={() => setAboutOpen(true)}
              title={t('aboutTitle')}
              aria-label={t('aboutTitle')}
            >
              <InfoGlyph />
            </button>
          </div>
          <div className="sidebar-meta">
            <span className="sidebar-tagline">{t('tagline')}</span>
            <span className="sidebar-author">{t('author')}</span>
          </div>
          <div className="sidebar-language-row">
            <span className="sidebar-language-label">
              <GlobeGlyph />
              <span>{t('language')}</span>
            </span>
            <LanguageMenu label={t('language')} />
          </div>
          <div className="sidebar-socials">
            <button
              type="button"
              className="sidebar-social-btn"
              onClick={() => openUrl(WEBSITE_URL)}
              title="Website"
              aria-label="Website"
            >
              <img
                src="./website-icon.svg"
                width="20"
                height="20"
                alt=""
                aria-hidden="true"
                draggable={false}
              />
            </button>
            <button
              type="button"
              className="sidebar-social-btn"
              onClick={() => openUrl(INSTAGRAM_URL)}
              title="Instagram (@araoffice_ai)"
              aria-label="Instagram"
            >
              <img
                src="./instagram-icon.svg"
                width="20"
                height="20"
                alt=""
                aria-hidden="true"
                draggable={false}
              />
            </button>
            <button
              type="button"
              className="sidebar-social-btn"
              onClick={() => openUrl(REPO_URL)}
              title="GitHub"
              aria-label="GitHub"
            >
              <GithubGlyph />
            </button>
            <button
              type="button"
              className="sidebar-social-btn ai-provider-trigger"
              title={aiStatus.connected ? `Settings (${aiLabel})` : 'Settings'}
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded={aiMenuOpen}
              onClick={() => openSettingsAt('profile')}
            >
              <SettingsGlyph />
            </button>
          </div>
        </div>
      </aside>

      <main className="content">
        <section className="quick-start" id="home-top">
          <div className="home-hero">
            <div className="hero-greeting-block">
              <h1 className="hero-title">
                {greetingPrefix},{' '}
                <button
                  type="button"
                  className="hero-user-btn"
                  title="Edit profile name in Settings"
                  onClick={() => openSettingsAt('profile')}
                >
                  {userName}
                </button>
                .
              </h1>
              <p className="hero-subtitle">{dailyPrompt}</p>
            </div>
            <div className="hero-actions">
              <button
                className="open-file-button"
                title={t('openPdf')}
                onClick={() => void window.reader.openPdf()}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>{t('openPdf')}</span>
              </button>
              <button
                type="button"
                className="home-action-button"
                title={t('newPdf')}
                onClick={createPdf}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
                <span>{t('newPdf')}</span>
              </button>
            </div>
          </div>
          {newPdfError && (
            <p className="home-error" role="alert">
              {newPdfError}
            </p>
          )}
        </section>

        <section className="recents" id="recents" aria-label={t('secRecent')}>
          <div className="recents-toolbar">
            <div className="recents-heading">
              <span className="section-label">
                {section === 'starred' ? 'Starred' : t('secRecent')}
              </span>
              <span className="file-count">
                {searchQuery.trim()
                  ? `${filteredEntries.length} of ${baseEntries.length}`
                  : t(baseEntries.length === 1 ? 'fileCountOne' : 'fileCountMany', {
                      n: baseEntries.length,
                    })}
              </span>
            </div>
            {entries.length > 0 && (
              <div className="search-wrap">
                <svg
                  className="search-icon-svg"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  ref={searchInputRef}
                  className="search-input"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter documents by name or path…"
                  aria-label="Filter documents"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="search-clear-btn"
                    onClick={() => setSearchQuery('')}
                    title="Clear filter"
                    aria-label="Clear filter"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>

          {!loaded ? null : entries.length === 0 ? (
            <div className="empty proj-empty">
              <img
                className="empty-brand-logo empty-brand-dark"
                src="./ARA_dark.png"
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              <img
                className="empty-brand-logo empty-brand-light"
                src="./ARA_light.png"
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              <span className="empty-hint">{t('emptyRecent')}</span>
              <button
                type="button"
                className="btn btn-primary empty-open-btn"
                onClick={() => void window.reader.openPdf()}
              >
                {t('openPdf')}
              </button>
            </div>
          ) : section === 'starred' && baseEntries.length === 0 ? (
            <div className="home-search-empty">
              <p>No starred documents yet. Click the star icon on any recent PDF to pin it here.</p>
              <button type="button" className="btn-ghost-sm" onClick={() => setSection('home')}>
                Show all recent PDFs
              </button>
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="home-search-empty">
              <p>No documents matching &ldquo;{searchQuery}&rdquo;</p>
              <button type="button" className="btn-ghost-sm" onClick={() => setSearchQuery('')}>
                Clear filter
              </button>
            </div>
          ) : (
            <div className="recent-table">
              <div className="recent-columns">
                <span className="col-icon" aria-hidden="true" />
                <span className="col-name">{t('colName')}</span>
                <span className="col-location">{t('colLocation')}</span>
                <span className="col-modified">{t('colModified')}</span>
                <span className="col-size">{t('colSize')}</span>
                <span className="col-actions" aria-hidden="true" />
              </div>
              <ul className="recent-list">
                {filteredEntries.map((entry) => {
                  const isStarred = starredPaths.includes(entry.path)
                  return (
                    <li className="recent-row" key={entry.path}>
                      <div
                        className="recent-item"
                        role="button"
                        tabIndex={0}
                        onClick={() => void window.reader.openPath(entry.path)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && event.target === event.currentTarget) {
                            void window.reader.openPath(entry.path)
                          }
                        }}
                      >
                        <span className="recent-icon">
                          <PdfGlyph size={22} />
                        </span>
                        <span className="recent-name">{entry.name}</span>
                        <span className="recent-path">{parentDir(entry.path)}</span>
                        <span className="recent-time">{formatDate(entry.mtimeMs, dateLocale)}</span>
                        <span className="recent-size">{formatSize(entry.sizeBytes)}</span>
                        <span className="recent-actions">
                          <button
                            type="button"
                            className={`star-btn${isStarred ? ' active' : ''}`}
                            title={isStarred ? 'Unstar document' : 'Star document'}
                            aria-label={isStarred ? `Unstar ${entry.name}` : `Star ${entry.name}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleStar(entry.path)
                            }}
                          >
                            <StarGlyph filled={isStarred} />
                          </button>
                          <button
                            type="button"
                            className="more-btn"
                            title={t('removeFromList')}
                            aria-label={`${t('removeFromList')}: ${entry.name}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              removeEntry(entry.path)
                            }}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                              aria-hidden="true"
                            >
                              <path d="M6 6l12 12M18 6L6 18" />
                            </svg>
                          </button>
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </section>
      </main>
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
      {aiMenuOpen && (
        <ProviderModal
          onClose={() => setAiMenuOpen(false)}
          onSaved={refreshAi}
          initialSection={settingsInitialTab}
        />
      )}
      {showChangelog && (
        <ChangelogModal
          onClose={() => setShowChangelog(false)}
          updateState={updateState}
          onRestart={restartNow}
        />
      )}
      {showUpdateRestart && (
        <UpdateRestartModal
          onClose={() => setShowUpdateRestart(false)}
          updateState={updateState}
          onRestart={restartNow}
          onOpenChangelog={() => setShowChangelog(true)}
        />
      )}
      {onboardOpen && (
        <OnboardingModal
          initialDisplayName={prefsRef.current?.profile?.displayName}
          initialFullName={prefsRef.current?.profile?.fullName}
          onSave={handleSaveOnboarding}
          onSkip={handleSkipOnboarding}
        />
      )}
    </div>
  )
}
