import { useEffect, useState } from 'react'
import { useI18n } from './locale'

const REPO_URL = 'https://github.com/funara/arareader'
const LICENSE = 'GPL-3.0-or-later'

/** About card: version from the host, license, and the public repository link. */
export function AboutModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.reader
      .getAppVersion()
      .then(setVersion)
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const openRepo = () => void window.readerWindow.openExternal(REPO_URL).catch(() => {})

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('aboutTitle')}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal">
        <h3>{t('aboutTitle')}</h3>
        <p className="about-tagline">{t('tagline')}</p>
        <dl className="about-rows">
          <dt>{t('versionLabel')}</dt>
          <dd>{version || '—'}</dd>
          <dt>{t('licenseLabel')}</dt>
          <dd>{LICENSE}</dd>
          <dt>{t('repositoryLabel')}</dt>
          <dd>
            <button type="button" className="about-link" onClick={openRepo}>
              github.com/funara/arareader
            </button>
          </dd>
        </dl>
        <div className="modal-buttons">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}
