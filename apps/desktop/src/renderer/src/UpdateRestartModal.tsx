import { useEffect } from 'react'
import type { AppUpdateState } from '../../shared/update-api'

interface UpdateRestartModalProps {
  onClose: () => void
  updateState: AppUpdateState
  onRestart: () => void
  onOpenChangelog?: () => void
}

/**
 * Downloaded-update prompt: restart applies the update silently. Host UI copy
 * is English-only. The eyebrow pill opens the changelog when wired up.
 */
export function UpdateRestartModal({
  onClose,
  updateState,
  onRestart,
  onOpenChangelog,
}: UpdateRestartModalProps) {
  const version = updateState.availableVersion || updateState.currentVersion || ''

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="modal-overlay update-modal-overlay" onClick={onClose}>
      <div
        className="modal update-restart-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Update ready"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="update-modal-top">
          <div
            className={`update-eyebrow-pill ${onOpenChangelog ? 'clickable' : ''}`}
            onClick={
              onOpenChangelog
                ? () => {
                    onClose()
                    onOpenChangelog()
                  }
                : undefined
            }
            role={onOpenChangelog ? 'button' : undefined}
            tabIndex={onOpenChangelog ? 0 : undefined}
          >
            <span>v{version}</span>
          </div>
          <button
            type="button"
            className="update-close-btn"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="update-modal-badge">
          <div className="update-badge-icon">
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>

        <h3 className="update-modal-title">Update ready to install</h3>
        <p className="update-modal-desc">
          ARAReader v{version} has been downloaded and is ready to install.
        </p>
        <div className="update-notice-box">
          <div className="update-notice-item">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="notice-icon-check"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>The app will close and apply the update silently.</span>
          </div>
          <div className="update-notice-item">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="notice-icon-spin"
              aria-hidden="true"
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span>ARAReader will reopen automatically in a few seconds.</span>
          </div>
          <div className="update-notice-item update-notice-warn">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="notice-icon-warn"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>Please do not shut down your computer during this process.</span>
          </div>
        </div>

        <div className="update-modal-actions">
          <button type="button" className="btn btn-secondary update-later-btn" onClick={onClose}>
            Later
          </button>
          <button
            type="button"
            className="btn btn-primary update-restart-btn"
            onClick={onRestart}
            autoFocus
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span>Restart Now</span>
          </button>
        </div>
      </div>
    </div>
  )
}
