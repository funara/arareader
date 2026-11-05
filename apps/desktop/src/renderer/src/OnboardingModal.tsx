import { useState, useEffect } from 'react'
import type { FormEvent, ReactElement } from 'react'
import type { AiProviderId, AiSettings } from '@arareader/ai-provider'
import {
  CUSTOM_ENDPOINT_PRESETS,
  DEFAULT_CUSTOM_MODEL,
  DEFAULT_GOOGLE_MODEL,
  GOOGLE_MODELS,
} from '@arareader/ai-provider'

interface OnboardingModalProps {
  initialDisplayName?: string
  initialFullName?: string
  onSave: (displayName: string, fullName: string, useAsDefaultAuthor: boolean) => void
  onSkip: () => void
}

const AI_STUDIO_URL = 'https://aistudio.google.com/apikey'

function isLocalhostEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl.trim())
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  )
}

/**
 * First-launch profile and AI copilot onboarding modal.
 * Step 1: Collects the user's name for PDF credential authoring and Home greeting.
 * Step 2: Allows setting up the optional BYO-key AI copilot (Google Gemini or OpenAI/Local).
 */
export function OnboardingModal({
  initialDisplayName = '',
  initialFullName = '',
  onSave,
  onSkip,
}: OnboardingModalProps): ReactElement {
  const [step, setStep] = useState<1 | 2>(1)

  // Step 1: Profile credentials
  const [displayName, setDisplayName] = useState(
    initialDisplayName && initialDisplayName !== 'Reader' && initialDisplayName !== 'ARAReader'
      ? initialDisplayName
      : '',
  )
  const [fullName, setFullName] = useState(
    initialFullName && initialFullName !== 'ARAReader' ? initialFullName : '',
  )
  const [useDefaultAuthor, setUseDefaultAuthor] = useState(true)

  // Step 2: AI Copilot configuration
  const [choice, setChoice] = useState<AiProviderId>('google')
  const [googleModel, setGoogleModel] = useState<string>(DEFAULT_GOOGLE_MODEL)
  const [googleKey, setGoogleKey] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [customKey, setCustomKey] = useState('')
  const [customModel, setCustomModel] = useState(DEFAULT_CUSTOM_MODEL)
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Load existing AI settings if any
  useEffect(() => {
    let active = true
    if (window.readerAi?.getSettings) {
      window.readerAi
        .getSettings()
        .then((settings) => {
          if (!active || !settings) return
          if (settings.provider) setChoice(settings.provider)
          if (settings.providers?.google?.model) {
            setGoogleModel(settings.providers.google.model)
          }
          if (settings.providers?.custom) {
            if (settings.providers.custom.baseUrl) {
              setEndpoint(settings.providers.custom.baseUrl)
            }
            if (settings.providers.custom.model) {
              setCustomModel(settings.providers.custom.model)
            }
          }
        })
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onSkip()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onSkip])

  const openStudio = () => {
    if (window.readerWindow?.openExternal) {
      void window.readerWindow.openExternal(AI_STUDIO_URL).catch(() => {})
    } else {
      window.open(AI_STUDIO_URL, '_blank')
    }
  }

  const handleStep1Submit = (e: FormEvent) => {
    e.preventDefault()
    setStep(2)
  }

  const handleFinish = async (skipAi = false) => {
    setError('')
    const dn = displayName.trim() || fullName.trim() || 'ARAReader'
    const fn = fullName.trim() || dn || 'ARAReader'

    if (!skipAi && choice === 'custom' && endpoint.trim() && !isHttpUrl(endpoint)) {
      setError('Please enter a valid HTTP or HTTPS endpoint URL.')
      return
    }

    setSaving(true)

    if (!skipAi && window.readerAi?.setSettings) {
      try {
        const stored = (await window.readerAi.getSettings().catch(() => null)) as AiSettings | null
        const baseUrl = endpoint.trim().replace(/\/+$/, '')
        const nextAi: AiSettings = {
          provider: choice,
          providers: {
            google:
              choice === 'google'
                ? {
                    model: googleModel.trim() || DEFAULT_GOOGLE_MODEL,
                    apiKey: googleKey.trim() || stored?.providers?.google?.apiKey || '',
                  }
                : (stored?.providers?.google ?? { model: DEFAULT_GOOGLE_MODEL, apiKey: '' }),
            custom:
              choice === 'custom' && baseUrl
                ? {
                    model: customModel.trim() || DEFAULT_CUSTOM_MODEL,
                    baseUrl,
                    apiKey: customKey.trim() || stored?.providers?.custom?.apiKey || '',
                  }
                : (stored?.providers?.custom ?? {
                    model: DEFAULT_CUSTOM_MODEL,
                    baseUrl: '',
                    apiKey: '',
                  }),
          },
        }
        await window.readerAi.setSettings(nextAi)
      } catch (err) {
        console.warn('Failed to save AI settings in onboarding:', err)
      }
    }

    onSave(dn, fn, useDefaultAuthor)
  }

  const handleStep2Submit = (e: FormEvent) => {
    e.preventDefault()
    void handleFinish(false)
  }

  return (
    <div
      className="modal-overlay onboard-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to ARAReader"
      onClick={(e) => {
        if (e.target === e.currentTarget) onSkip()
      }}
    >
      <div className="modal onboard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="onboard-header">
          <div className="onboard-brand">
            <img
              className="onboard-brand-logo onboard-brand-logo-dark"
              src="./ARAReader_dark.png"
              alt="ARAReader"
              draggable={false}
            />
            <img
              className="onboard-brand-logo onboard-brand-logo-light"
              src="./ARAReader_light.png"
              alt="ARAReader"
              draggable={false}
            />
          </div>
          {step === 1 ? (
            <>
              <h3 className="onboard-title">Set up your PDF author credentials</h3>
              <p className="onboard-subtitle">
                Configure your author name so your documents, edits, annotations, and signatures are
                properly credited.
              </p>
            </>
          ) : (
            <>
              <h3 className="onboard-title">Configure your AI Copilot (Optional)</h3>
              <p className="onboard-subtitle">
                Connect your AI model for document analysis, summarization, and chat. ARAReader uses
                direct BYO-key connections with zero telemetry.
              </p>
            </>
          )}
        </div>

        {step === 1 ? (
          <>
            <div className="onboard-privacy-banner">
              <div className="onboard-privacy-icon">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>
              <div className="onboard-privacy-text">
                <strong>Your Privacy is Guaranteed</strong>
                <p>
                  Your credentials are stored exclusively on this device. ARAReader operates
                  entirely offline with zero telemetry or tracking, keeping your PDF workflow
                  private, fluid, and completely yours.
                </p>
              </div>
            </div>

            <form onSubmit={handleStep1Submit} className="onboard-form">
              <div className="onboard-field">
                <label htmlFor="onboard-display-name">Display Name</label>
                <input
                  id="onboard-display-name"
                  type="text"
                  className="onboard-input"
                  value={displayName}
                  placeholder="e.g. Jhon"
                  autoFocus
                  maxLength={80}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
                <span className="onboard-hint">Used in your Home greeting and UI session.</span>
              </div>

              <div className="onboard-field">
                <label htmlFor="onboard-full-name">Full Name</label>
                <input
                  id="onboard-full-name"
                  type="text"
                  className="onboard-input"
                  value={fullName}
                  placeholder="e.g. Jhon Doe"
                  maxLength={120}
                  onChange={(e) => setFullName(e.target.value)}
                />
                <span className="onboard-hint">
                  Applied as author credentials in PDF metadata, comments, and signatures.
                </span>
              </div>

              <label className="onboard-checkbox-label">
                <input
                  type="checkbox"
                  checked={useDefaultAuthor}
                  onChange={(e) => setUseDefaultAuthor(e.target.checked)}
                />
                <span>Set as default author for created and edited PDFs</span>
              </label>

              <div className="onboard-footer">
                <div className="onboard-footer-left" />
                <div className="onboard-stepper" aria-label="Step 1 of 2">
                  <span className="onboard-dot active" aria-hidden="true" />
                  <span className="onboard-dot" aria-hidden="true" />
                </div>
                <div className="onboard-footer-right">
                  <button type="submit" className="btn btn-primary">
                    Next →
                  </button>
                </div>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="ai-provider-switch" role="tablist" aria-label="AI provider">
              <button
                type="button"
                role="tab"
                aria-selected={choice === 'google'}
                className={`ai-provider-switch-btn${choice === 'google' ? ' active' : ''}`}
                onClick={() => {
                  setChoice('google')
                  setError('')
                }}
              >
                Gemini (Google AI)
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={choice === 'custom'}
                className={`ai-provider-switch-btn${choice === 'custom' ? ' active' : ''}`}
                onClick={() => {
                  setChoice('custom')
                  setError('')
                }}
              >
                OpenAI-Compatible / Local
              </button>
            </div>

            <form onSubmit={handleStep2Submit} className="onboard-form">
              {choice === 'google' ? (
                <div className="ai-provider-fields">
                  <div className="ai-provider-field">
                    <label htmlFor="onboard-google-model" className="ai-provider-label">
                      Model
                    </label>
                    <select
                      id="onboard-google-model"
                      value={googleModel}
                      onChange={(e) => setGoogleModel(e.target.value)}
                    >
                      {GOOGLE_MODELS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="ai-provider-field">
                    <div className="ai-provider-label-row">
                      <label htmlFor="onboard-google-key" className="ai-provider-label">
                        API Key
                      </label>
                      <button type="button" className="ai-provider-link" onClick={openStudio}>
                        Get a free key ↗
                      </button>
                    </div>
                    <div className="ai-provider-input-wrap">
                      <input
                        id="onboard-google-key"
                        type={showKey ? 'text' : 'password'}
                        autoComplete="off"
                        spellCheck={false}
                        value={googleKey}
                        placeholder="AIza…"
                        onChange={(e) => setGoogleKey(e.target.value)}
                      />
                      <button
                        type="button"
                        className="ai-provider-eye"
                        onClick={() => setShowKey((prev) => !prev)}
                        tabIndex={-1}
                        aria-label={showKey ? 'Hide key' : 'Show key'}
                        title={showKey ? 'Hide key' : 'Show key'}
                      >
                        <EyeIcon off={showKey} />
                      </button>
                    </div>
                    <p className="ai-provider-hint">
                      Free Gemini keys are available from Google AI Studio. Stored strictly on this
                      device.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="ai-provider-fields">
                  <div className="ai-provider-field">
                    <label htmlFor="onboard-custom-endpoint" className="ai-provider-label">
                      Endpoint
                    </label>
                    <input
                      id="onboard-custom-endpoint"
                      value={endpoint}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="https://api.openai.com/v1"
                      onChange={(e) => setEndpoint(e.target.value)}
                    />
                    <div className="ai-provider-presets">
                      {CUSTOM_ENDPOINT_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className="ai-provider-preset"
                          onClick={() => setEndpoint(preset.baseUrl)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="ai-provider-field">
                    <div className="ai-provider-label-row">
                      <label htmlFor="onboard-custom-key" className="ai-provider-label">
                        API Key
                        {isLocalhostEndpoint(endpoint) && (
                          <span className="ai-provider-optional">optional</span>
                        )}
                      </label>
                    </div>
                    <div className="ai-provider-input-wrap">
                      <input
                        id="onboard-custom-key"
                        type={showKey ? 'text' : 'password'}
                        autoComplete="off"
                        spellCheck={false}
                        value={customKey}
                        placeholder="sk-…"
                        onChange={(e) => setCustomKey(e.target.value)}
                      />
                      <button
                        type="button"
                        className="ai-provider-eye"
                        onClick={() => setShowKey((prev) => !prev)}
                        tabIndex={-1}
                        aria-label={showKey ? 'Hide key' : 'Show key'}
                        title={showKey ? 'Hide key' : 'Show key'}
                      >
                        <EyeIcon off={showKey} />
                      </button>
                    </div>
                    <p className="ai-provider-hint">
                      {isLocalhostEndpoint(endpoint)
                        ? 'Local models (e.g. Ollama or LM Studio) usually run without an API key.'
                        : 'Your key is saved locally in private app settings.'}
                    </p>
                  </div>

                  <div className="ai-provider-field">
                    <label htmlFor="onboard-custom-model" className="ai-provider-label">
                      Model ID
                    </label>
                    <input
                      id="onboard-custom-model"
                      value={customModel}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={DEFAULT_CUSTOM_MODEL}
                      onChange={(e) => setCustomModel(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {error && <p className="ai-provider-error">{error}</p>}

              <div className="onboard-footer">
                <div className="onboard-footer-left">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handleFinish(true)}
                    disabled={saving}
                  >
                    Skip for now
                  </button>
                </div>
                <div className="onboard-stepper" aria-label="Step 2 of 2">
                  <span className="onboard-dot" aria-hidden="true" />
                  <span className="onboard-dot active" aria-hidden="true" />
                </div>
                <div className="onboard-footer-right">
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    {saving ? 'Saving…' : 'Get Started'}
                  </button>
                </div>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
