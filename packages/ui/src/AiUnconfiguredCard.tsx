/**
 * Shown instead of the AI composer while no provider is configured.
 *
 * ARAReader has no accounts and no sign-in: the user configures a provider
 * (a Gemini API key, or any OpenAI-compatible endpoint) and the AI panel
 * becomes usable. The card points at that one action.
 */

export interface AiUnconfiguredCardProps {
  /** open the provider setup. Defaults to the 'ara:configure-ai' window event. */
  readonly onConfigure?: (() => void) | undefined
  /** override the body copy (localized) */
  readonly body?: string | undefined
  /** override the button label (localized) */
  readonly actionLabel?: string | undefined
}

/** Fired on `window` so a host (the shell) can open its provider settings. */
export const AI_CONFIGURE_EVENT = 'ara:configure-ai'

export function AiUnconfiguredCard({
  onConfigure,
  body = 'To start using ARA Assistant, add a free Gemini API key from Google AI Studio or connect your local model (Ollama / LM Studio).',
  actionLabel = 'Configure AI Provider',
}: AiUnconfiguredCardProps) {
  const configure = (): void => {
    if (onConfigure) {
      onConfigure()
      return
    }
    window.dispatchEvent(new CustomEvent(AI_CONFIGURE_EVENT))
  }

  return (
    <div className="ai-unconfigured-card">
      <div className="ai-unconfigured-mark" aria-hidden>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </div>
      <div className="ai-unconfigured-title">Document Intelligence</div>
      <div className="ai-unconfigured-body">{body}</div>
      <button className="ai-unconfigured-button" type="button" onClick={configure}>
        {actionLabel}
      </button>
    </div>
  )
}
