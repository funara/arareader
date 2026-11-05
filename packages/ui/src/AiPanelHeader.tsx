import type { ReactNode } from 'react'
import { IconClock, IconNewChat, IconSidebarCollapse, IconSparkles } from './icons'

export interface AiPanelHeaderProps {
  readonly title?: string | undefined
  readonly newChatLabel?: string | undefined
  readonly collapseLabel?: string | undefined
  readonly snapshotsLabel?: string | undefined
  readonly onNewChat?: (() => void) | undefined
  readonly onCollapse?: (() => void) | undefined
  readonly showNewChat?: boolean | undefined
  readonly newChatIcon?: ReactNode | undefined
  readonly collapseIcon?: ReactNode | undefined
  readonly onTriggerScan?: (() => void) | undefined
  readonly isScanning?: boolean | undefined
  readonly showTriggerScan?: boolean | undefined
  readonly triggerScanLabel?: string | undefined
  readonly triggerScanIcon?: ReactNode | undefined
  readonly snapshotsCount?: number | undefined
  readonly isSnapshotsOpen?: boolean | undefined
  readonly onToggleSnapshots?: (() => void) | undefined
  readonly snapshotsIcon?: ReactNode | undefined
  readonly children?: ReactNode | undefined
  readonly live?: boolean | undefined
}

export function AiPanelHeader({
  title = 'ARA Assistant',
  newChatLabel = 'New chat',
  collapseLabel = 'Collapse assistant',
  snapshotsLabel = 'Version Snapshots',
  onNewChat,
  onCollapse,
  showNewChat = Boolean(onNewChat),
  newChatIcon = <IconNewChat size={15} />,
  collapseIcon = <IconSidebarCollapse size={15} />,
  onTriggerScan,
  isScanning = false,
  showTriggerScan = Boolean(onTriggerScan),
  triggerScanLabel = 'Analyze document context',
  triggerScanIcon = <IconSparkles size={15} />,
  snapshotsCount,
  isSnapshotsOpen,
  onToggleSnapshots,
  snapshotsIcon = <IconClock size={15} />,
  children,
  live = false,
}: AiPanelHeaderProps): React.JSX.Element {
  const hasSnapshots = typeof snapshotsCount === 'number' && snapshotsCount > 0

  return (
    <header className="ai-panel-header">
      <span className="ai-panel-title">
        <span className="ai-panel-title-text">{title}</span>
        {live && <span className="ai-panel-live-dot" aria-hidden="true" />}
      </span>

      <div className="ai-panel-header-actions">
        {showTriggerScan && onTriggerScan && (
          <button
            className={`ai-header-btn${isScanning ? ' active is-scanning' : ''}`}
            type="button"
            onClick={onTriggerScan}
            title={isScanning ? 'Analyzing document context… (click to cancel)' : triggerScanLabel}
            aria-label={isScanning ? 'Analyzing document context…' : triggerScanLabel}
          >
            {triggerScanIcon}
          </button>
        )}
        {hasSnapshots && onToggleSnapshots && (
          <button
            className={`ai-header-btn ai-snapshots-trigger${isSnapshotsOpen ? ' active' : ''}`}
            type="button"
            onClick={onToggleSnapshots}
            title={`${snapshotsLabel} (${snapshotsCount})`}
            aria-label={`${snapshotsLabel} (${snapshotsCount})`}
            aria-expanded={isSnapshotsOpen}
          >
            {snapshotsIcon}
            <span className="ai-snapshots-badge">{snapshotsCount}</span>
          </button>
        )}
        {showNewChat && onNewChat && (
          <button
            className="ai-header-btn"
            type="button"
            onClick={onNewChat}
            title={newChatLabel}
            aria-label={newChatLabel}
          >
            {newChatIcon}
          </button>
        )}
        {onCollapse && (
          <button
            className="ai-header-btn"
            type="button"
            onClick={onCollapse}
            title={collapseLabel}
            aria-label={collapseLabel}
          >
            {collapseIcon}
          </button>
        )}
      </div>
      {children}
    </header>
  )
}
