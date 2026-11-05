import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppUpdateState, ChangelogEntry } from '../../shared/update-api'

interface ChangelogModalProps {
  onClose: () => void
  updateState: AppUpdateState
  onRestart: () => void
}

const BADGE_MAP: Record<string, { label: string; className: string }> = {
  new: { label: 'NEW', className: 'chip-new' },
  feature: { label: 'NEW', className: 'chip-new' },
  feat: { label: 'NEW', className: 'chip-new' },
  add: { label: 'NEW', className: 'chip-new' },
  fix: { label: 'FIX', className: 'chip-fix' },
  fixes: { label: 'FIX', className: 'chip-fix' },
  bug: { label: 'FIX', className: 'chip-fix' },
}

function parseFormattedLine(line: string) {
  const tagMatch = line.match(/^(\*\*([a-zA-Z0-9_\s-]+)\*\*|\[([a-zA-Z0-9_\s-]+)\]):\s*(.*)$/)
  if (tagMatch) {
    const rawTag = (tagMatch[2] || tagMatch[3] || '').trim().toLowerCase()
    const rest = tagMatch[4]
    const badgeInfo = BADGE_MAP[rawTag]
    if (badgeInfo) {
      return { badge: badgeInfo, content: rest }
    }
    return { badge: null, content: `${tagMatch[2] || tagMatch[3]}: ${rest}` }
  }
  return { badge: null, content: line }
}

function formatInline(str: string) {
  const parts = str.split(/(\*\*.*?\*\*|`.*?`)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="cl-code">
          {part.slice(1, -1)}
        </code>
      )
    }
    return part
  })
}

/** release-note body: headings, bullet lists, [TAG]: badges, **bold**, `code` */
function renderMarkdownBody(text: string): ReactNode {
  if (!text) return null
  const lines = text.split('\n')
  const elements: ReactNode[] = []

  let listItems: ReactNode[] = []
  let listKey = 0

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={`list-${listKey++}`} className="cl-list">
          {listItems}
        </ul>,
      )
      listItems = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim()
    if (!rawLine) {
      flushList()
      continue
    }

    if (rawLine.startsWith('### ') || rawLine.startsWith('## ') || rawLine.startsWith('# ')) {
      flushList()
      const headingText = rawLine.replace(/^#+\s*/, '')
      elements.push(
        <h4 key={`h-${i}`} className="cl-heading">
          {headingText}
        </h4>,
      )
    } else if (rawLine.startsWith('- ') || rawLine.startsWith('* ')) {
      const itemText = rawLine.slice(2).trim()
      const { badge, content } = parseFormattedLine(itemText)
      listItems.push(
        <li key={`li-${i}`} className={`cl-list-item ${badge ? 'has-badge' : ''}`}>
          {badge && <span className={`cl-tag ${badge.className}`}>{badge.label}</span>}
          <span className="cl-item-text">{formatInline(content)}</span>
        </li>,
      )
    } else {
      flushList()
      const { badge, content } = parseFormattedLine(rawLine)
      elements.push(
        <p key={`p-${i}`} className="cl-paragraph">
          {badge && <span className={`cl-tag ${badge.className}`}>{badge.label}</span>}
          <span>{formatInline(content)}</span>
        </p>,
      )
    }
  }
  flushList()

  return elements
}

function formatReleaseDate(publishedAt: string): string {
  if (!publishedAt) return ''
  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) return publishedAt
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * Release history + update status. The version pill opens this; once a download
 * finishes the restart prompt takes over. Host UI copy is English-only.
 */
export function ChangelogModal({ onClose, updateState, onRestart }: ChangelogModalProps) {
  const [entries, setEntries] = useState<ChangelogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [checkingManual, setCheckingManual] = useState(false)

  const loadData = useCallback(() => {
    setLoading(true)
    void window.reader
      .getChangelog()
      .then((res) => {
        setEntries(res)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleManualCheck = () => {
    setCheckingManual(true)
    void window.reader.checkForUpdates()
    setTimeout(() => {
      loadData()
      setCheckingManual(false)
    }, 1200)
  }

  const openExternal = (url: string) => {
    void window.readerWindow.openExternal(url).catch(() => {})
  }

  const isDownloaded = updateState.status === 'downloaded'
  const isDownloading = updateState.status === 'downloading'

  return (
    <div className="modal-overlay cl-overlay" onClick={onClose}>
      <div
        className="cl-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Changelog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cl-header">
          <div className="cl-header-left">
            <span className="cl-eyebrow">ARAREADER</span>
            <h2 className="cl-title">What&apos;s New</h2>
          </div>
          <button
            type="button"
            className="cl-close-btn"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {isDownloaded ? (
          <div className="cl-update-banner ready">
            <div className="cl-banner-content">
              <div className="cl-pulse-ring ready" />
              <div>
                <strong>Update ready to install</strong>
                <p>ARAReader v{updateState.availableVersion ?? ''} is downloaded.</p>
              </div>
            </div>
            <button type="button" className="btn btn-primary cl-banner-action" onClick={onRestart}>
              Restart Now
            </button>
          </div>
        ) : isDownloading ? (
          <div className="cl-update-banner downloading">
            <div className="cl-banner-content">
              <div className="cl-pulse-ring downloading" />
              <div>
                <strong>Update available</strong>
                <p>Downloading update ({updateState.percent ?? 0}%)…</p>
              </div>
            </div>
            <div className="cl-progress-bar">
              <div className="cl-progress-fill" style={{ width: `${updateState.percent ?? 0}%` }} />
            </div>
          </div>
        ) : null}

        <div className="cl-body">
          {loading ? (
            <div className="cl-empty-state">
              <div className="cl-spinner" />
              <span>Loading release notes…</span>
            </div>
          ) : entries.length === 0 ? (
            <div className="cl-empty-state">
              <p>No release notes yet.</p>
            </div>
          ) : (
            <div className="cl-timeline">
              {entries.map((entry, index) => (
                <article key={entry.version || index} className="cl-card">
                  <div className="cl-card-header">
                    <span className="cl-version-badge">v{entry.version}</span>
                    {entry.publishedAt && (
                      <time className="cl-card-date">{formatReleaseDate(entry.publishedAt)}</time>
                    )}
                  </div>

                  <div className="cl-card-body">
                    {renderMarkdownBody(entry.body || 'No release notes for this version.')}
                  </div>

                  {entry.htmlUrl && (
                    <div className="cl-card-footer">
                      <button
                        type="button"
                        className="cl-link-btn"
                        onClick={() => {
                          if (entry.htmlUrl) openExternal(entry.htmlUrl)
                        }}
                      >
                        GitHub Release
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                        >
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>

        {(() => {
          const isChecking = checkingManual || updateState.status === 'checking'
          const isError = updateState.status === 'error'
          // main flags the no-auto-update platform through the error text (the status union is fixed)
          const manualUrl =
            isError && updateState.error?.includes('Auto-update is not available on this platform')
              ? (updateState.error?.match(/https:\/\/\S+/)?.[0] ?? null)
              : null

          let statusDotClass: string
          let statusText: string

          if (manualUrl) {
            statusDotClass = 'error'
            statusText = 'Manual download required'
          } else if (isChecking) {
            statusDotClass = 'checking'
            statusText = 'Checking for updates…'
          } else if (isDownloading) {
            statusDotClass = 'downloading'
            statusText = `Downloading update (${updateState.percent ?? 0}%)…`
          } else if (isDownloaded) {
            statusDotClass = 'ready'
            statusText = `v${updateState.availableVersion ?? ''} · Ready to install`
          } else if (isError) {
            statusDotClass = 'error'
            statusText = 'Update check failed'
          } else {
            statusDotClass = ''
            statusText = `${updateState.currentVersion ? `v${updateState.currentVersion}` : ''} · Up to date`
          }

          return (
            <footer className="cl-footer">
              <div className="cl-footer-status">
                <span className={`cl-status-dot ${statusDotClass}`} />
                <span>{statusText}</span>
              </div>

              <div className="cl-footer-actions">
                {isDownloaded ? (
                  <button type="button" className="btn btn-primary cl-btn-done" onClick={onRestart}>
                    Restart Now
                  </button>
                ) : manualUrl ? (
                  <button
                    type="button"
                    className="btn btn-secondary cl-btn-check"
                    onClick={() => openExternal(manualUrl)}
                  >
                    Download Update
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`btn btn-secondary cl-btn-check ${isChecking ? 'loading' : ''}`}
                    onClick={handleManualCheck}
                    disabled={isChecking || isDownloading || loading}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      className={`cl-refresh-icon ${isChecking ? 'spin' : ''}`}
                    >
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                    <span>{isChecking ? 'Checking…' : 'Check for Updates'}</span>
                  </button>
                )}
                <button
                  type="button"
                  className={`btn ${isDownloaded ? 'btn-secondary' : 'btn-primary'} cl-btn-done`}
                  onClick={onClose}
                >
                  Done
                </button>
              </div>
            </footer>
          )
        })()}
      </div>
    </div>
  )
}
