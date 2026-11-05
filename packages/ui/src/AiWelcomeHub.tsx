import type { ReactNode } from 'react'
import { AraSpark } from './icons'

export interface QuickActionCard {
  readonly id: string
  readonly icon?: ReactNode | undefined
  readonly title: string
  readonly subtitle?: string | undefined
  readonly onClick: () => void
}

export interface ContextBadge {
  readonly icon?: ReactNode | undefined
  readonly label: string
  readonly title?: string | undefined
  readonly action?:
    | {
        readonly label: string
        readonly title?: string | undefined
        readonly onClick: () => void
      }
    | undefined
}

export interface AiWelcomeHubProps {
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly contextBadge?: ContextBadge | undefined
  readonly isScanning?: boolean | undefined
  readonly onEmblemClick?: (() => void) | undefined
  readonly cards?: readonly QuickActionCard[] | undefined
  readonly children?: ReactNode | undefined
}

/**
 * Welcoming empty-state hub inside the AI Assistant panel:
 * - Warm emblem + greeting title & concise subtitle
 * - Up to 3 polished quick-start suggestion buttons
 */
export function AiWelcomeHub({
  title = 'How can ARA help you?',
  description,
  contextBadge,
  isScanning = false,
  onEmblemClick,
  cards,
  children,
}: AiWelcomeHubProps): React.JSX.Element {
  return (
    <div className="ai-welcome-hub">
      <div className="ai-hub-hero">
        <div
          className={`ai-hub-emblem${isScanning ? ' is-scanning' : ''}${onEmblemClick ? ' is-clickable' : ''}`}
          aria-hidden={!onEmblemClick}
          role={onEmblemClick ? 'button' : undefined}
          tabIndex={onEmblemClick ? 0 : undefined}
          onClick={onEmblemClick}
          onKeyDown={
            onEmblemClick
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onEmblemClick()
                  }
                }
              : undefined
          }
          title={
            onEmblemClick
              ? isScanning
                ? 'Gathering document context… (click to cancel)'
                : 'Analyze document context'
              : undefined
          }
        >
          <AraSpark size={20} />
        </div>
        {title && <h4 className="ai-hub-title">{title}</h4>}
        {description && <p className="ai-hub-desc">{description}</p>}

        {contextBadge && (
          <div className="ai-hub-context-pill" title={contextBadge.title ?? contextBadge.label}>
            {contextBadge.icon}
            <span>{contextBadge.label}</span>
            {contextBadge.action && (
              <button
                type="button"
                className="ai-hub-context-action"
                title={contextBadge.action.title ?? contextBadge.action.label}
                aria-label={contextBadge.action.title ?? contextBadge.action.label}
                onClick={(e) => {
                  e.stopPropagation()
                  contextBadge.action?.onClick()
                }}
              >
                {contextBadge.action.label}
              </button>
            )}
          </div>
        )}
      </div>

      {cards && cards.length > 0 && (
        <div className="ai-quick-grid">
          {cards.slice(0, 3).map((card) => (
            <button key={card.id} type="button" className="ai-quick-card" onClick={card.onClick}>
              {card.icon && <span className="quick-card-icon">{card.icon}</span>}
              <div className="quick-card-text">
                <span className="quick-card-title">{card.title}</span>
                {card.subtitle && <span className="quick-card-sub">{card.subtitle}</span>}
              </div>
              <span className="quick-card-arrow" aria-hidden="true">
                →
              </span>
            </button>
          ))}
        </div>
      )}

      {children}
    </div>
  )
}
