import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

export interface ToolDisplay {
  kind: 'images' | 'links' | 'text'
  text?: string
  items?: Array<{ url: string; title?: string }>
}

export interface ToolActivityItem {
  name?: string | undefined
  summary: string
  running?: boolean | undefined
  isError?: boolean | undefined
  /** queued but not executed because the run stopped (or hit a limit) */
  skipped?: boolean | undefined
  /** the tool changed the document */
  mutated?: boolean | undefined
  output?: string | undefined
  display?: ToolDisplay | undefined
}

/** Terminal state of the run this card belongs to (absent = a complete reply) */
export type AiProcessOutcome = 'stopped' | 'failed'

export interface AiProcessCardProps {
  thinking?: string | undefined
  tools?: readonly ToolActivityItem[] | undefined
  isStreaming?: boolean | undefined
  /** stopped/failed run: never reported as a completed run */
  outcome?: AiProcessOutcome | undefined
  durationSeconds?: number | undefined
  title?: string | undefined
  defaultExpanded?: boolean | undefined
  onOpenExternalUrl?: ((url: string) => void) | undefined
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const ALLOWED_EXTERNAL_PROTOCOLS: readonly string[] = ['http:', 'https:']

/**
 * Open a model-provided URL in the OS browser. Protocol allowlist is enforced
 * inline (same http/https gate as safeExternalUrl in electron-utils, which ui
 * cannot depend on); anything else returns before window.open.
 */
export function openExternalUrl(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.includes(protocol)) return
  window.open(url, '_blank', 'noreferrer')
}

/** Human-readable action label for a tool name */
function formatToolName(name?: string): string {
  if (!name) return 'Action'
  const FRIENDLY: Record<string, string> = {
    get_document_context: 'Reviewed document',
    read_blocks: 'Read document content',
    insert_content: 'Added content',
    replace_blocks: 'Updated content',
    insert_chart: 'Added chart',
    edit_chart: 'Edited chart',
    apply_commands: 'Formatted document',
    propose_operations: 'Updated spreadsheet',
    read_range: 'Checked cells',
    get_workbook_context: 'Checked workbook',
    generate_deck: 'Created presentation',
    edit_slide_script: 'Updated slide',
    web_search: 'Web search',
    fetch_url: 'Read webpage',
    // PDF assistant tools: a queued-but-not-run call only has its name, so the
    // name itself has to read as an action
    read_pages: 'Read pages',
    search_text: 'Searched text',
    goto_page: 'Jumped to page',
    get_outline: 'Read outline',
    list_form_fields: 'Listed form fields',
    fill_form_field: 'Filled form field',
    rotate_page: 'Rotated page',
    delete_page: 'Deleted page',
    markup_text: 'Added markup',
    add_note: 'Added note',
    edit_text_block: 'Edited text',
    set_outline: 'Updated outline',
    word_count: 'Counted words',
    get_metadata: 'Read metadata',
    set_metadata: 'Updated metadata',
    read_attachment: 'Read attachment',
  }
  if (FRIENDLY[name]) return FRIENDLY[name]
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const TOOL_OUTPUT_RENDER_MAX = 1500

/** One-line, text-only state of a chip: colour is never the only signal. */
function chipStatus(tool: ToolActivityItem): string {
  if (tool.running) return 'running'
  if (tool.skipped) return 'not run'
  if (tool.isError) return 'failed'
  return 'done'
}

function displayTitle(tool: ToolActivityItem): string {
  return tool.summary || formatToolName(tool.name)
}

export function AiProcessCard({
  thinking = '',
  tools = [],
  isStreaming = false,
  outcome,
  durationSeconds,
  title,
  defaultExpanded,
  onOpenExternalUrl,
}: AiProcessCardProps): React.JSX.Element | null {
  const hasThinking = Boolean(thinking && thinking.trim())
  const hasTools = tools.length > 0
  const anyRunning = isStreaming || tools.some((t) => t.running)

  // Auto-expand when execution starts; auto-collapse when execution completes
  const [expanded, setExpanded] = useState(defaultExpanded ?? anyRunning)
  const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set())
  const [copiedThinking, setCopiedThinking] = useState(false)
  const prevRunningRef = useRef(anyRunning)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const drawerId = useId()
  const thoughtRef = useRef<HTMLDivElement | null>(null)
  /** user scroll intent for the thought preview: scrolling up pauses the follow,
   * returning to the bottom resumes it (big streamed chunks would defeat a
   * near-bottom distance check, so the decision is made in onScroll instead) */
  const thoughtStickRef = useRef(true)

  useEffect(() => {
    if (anyRunning && !prevRunningRef.current) {
      setExpanded(true)
    } else if (!anyRunning && prevRunningRef.current) {
      setExpanded(false)
    }
    prevRunningRef.current = anyRunning
  }, [anyRunning])

  const onThoughtScroll = useCallback(() => {
    const el = thoughtRef.current
    if (!el) return
    thoughtStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [])

  // Autoscroll the drawer to the newest entry while the user stays near the
  // bottom; reading history above pauses the stickiness. The thought preview
  // follows the latest reasoning line while streaming unless the user scrolled up.
  useEffect(() => {
    if (!expanded) return
    const drawer = drawerRef.current
    if (drawer) {
      const nearBottom = drawer.scrollHeight - drawer.scrollTop - drawer.clientHeight < 80
      if (nearBottom) drawer.scrollTop = drawer.scrollHeight
    }
    const thought = thoughtRef.current
    if (thought && isStreaming && thoughtStickRef.current) {
      thought.scrollTop = thought.scrollHeight
    }
  }, [thinking, tools, isStreaming, expanded])

  const toggleTool = useCallback((idx: number) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  const copyReasoning = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!thinking) return
      void navigator.clipboard.writeText(thinking).then(() => {
        setCopiedThinking(true)
        setTimeout(() => setCopiedThinking(false), 1800)
      })
    },
    [thinking],
  )

  if (!hasThinking && !hasTools && !isStreaming) return null

  // Bound the rendered thought: marathon sessions can stream tens of KB of
  // reasoning per turn, and keeping every turn's full text in the DOM compounds
  // renderer memory. The Copy button still copies the complete `thinking` string.
  const MAX_RENDERED_THOUGHT_CHARS = 6000
  const visibleThinking =
    thinking.length > MAX_RENDERED_THOUGHT_CHARS
      ? `…${thinking.slice(-MAX_RENDERED_THOUGHT_CHARS)}`
      : thinking

  const toolCount = tools.length
  const stepLabel = toolCount === 1 ? '1 step' : `${toolCount} steps`
  const skippedCount = tools.filter((t) => t.skipped && !t.running).length
  const errorCount = tools.filter((t) => t.isError && !t.skipped && !t.running).length
  const successCount = toolCount - skippedCount - errorCount
  /** calls that actually ran (skipped ones never started) */
  const ranCount = toolCount - skippedCount

  // Summary header label
  let headerLabel = title
  if (!headerLabel) {
    if (anyRunning) {
      const runningTool = tools.find((t) => t.running)
      headerLabel = runningTool ? `Working: ${displayTitle(runningTool)}…` : 'Working…'
    } else if (!hasTools) {
      headerLabel = 'Reasoning'
    } else if (outcome === 'failed') {
      // The collapsed header has to carry the failure too: a collapsed card must
      // not read as a finished run
      headerLabel =
        successCount > 0
          ? `Failed after ${successCount} completed ${successCount === 1 ? 'action' : 'actions'}`
          : 'Action failed'
    } else if (ranCount > 0 && errorCount === ranCount) {
      headerLabel = ranCount === 1 ? 'Action failed' : `${ranCount} actions failed`
    } else if (successCount < toolCount && successCount + errorCount > 0) {
      headerLabel = `${successCount} of ${toolCount} steps completed`
    } else if (successCount > 0) {
      headerLabel = successCount === 1 ? '1 step completed' : `${successCount} steps completed`
    } else {
      headerLabel = outcome === 'stopped' ? 'Stopped before any action ran' : 'No action ran'
    }
  }

  // Footer: the honest end state. A failed/stopped run never ends in a green check.
  let footerKind: 'success' | 'error' | 'muted' = 'success'
  let footerLabel = '✓ Completed'
  if (outcome === 'stopped') {
    footerKind = 'muted'
    footerLabel =
      skippedCount > 0 ? `Stopped · ${skippedCount} not run` : 'Stopped · no rollback applied'
  } else if (outcome === 'failed') {
    footerKind = 'error'
    footerLabel = successCount > 0 ? 'Failed after these actions' : 'Failed'
  } else if (ranCount > 0 && errorCount === ranCount) {
    footerKind = 'error'
    footerLabel = errorCount === 1 ? '1 action failed' : `${errorCount} actions failed`
  } else if (errorCount > 0) {
    footerKind = 'error'
    footerLabel = `Completed with ${errorCount} failed`
  } else if (skippedCount > 0) {
    footerKind = 'muted'
    footerLabel = `Completed · ${skippedCount} not run`
  }

  return (
    <div className={`ai-process-box${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className="ai-process-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={drawerId}
      >
        <svg
          className={`ai-process-caret${expanded ? ' open' : ''}`}
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 4 10 8 6 12" />
        </svg>
        {anyRunning && <span className="ai-process-spinner" aria-hidden="true" />}
        <span className="ai-process-title">{headerLabel}</span>
        {anyRunning && hasTools && <span className="ai-process-badge">{stepLabel}</span>}
        {typeof durationSeconds === 'number' && durationSeconds > 0 && (
          <span className="ai-process-duration">({durationSeconds.toFixed(1)}s)</span>
        )}
      </button>

      {/* Compact Action Trail: Glanceable chips showing tool statuses at a glance */}
      {hasTools && !expanded && (
        <div className="ai-action-trail">
          {tools.map((t, idx) => (
            <button
              key={idx}
              type="button"
              className={`ai-action-chip ${t.running ? 'is-running' : t.skipped ? 'is-skipped' : t.isError ? 'is-error' : 'is-done'}`}
              title={`${displayTitle(t)} — ${chipStatus(t)}`}
              aria-label={`${displayTitle(t)} — ${chipStatus(t)}`}
              onClick={() => {
                setExpanded(true)
                toggleTool(idx)
              }}
            >
              {t.running ? (
                <span className="ai-action-chip-spinner" aria-hidden="true" />
              ) : t.skipped ? (
                <span className="ai-action-chip-err" aria-hidden="true">
                  –
                </span>
              ) : t.isError ? (
                <span className="ai-action-chip-err" aria-hidden="true">
                  ✕
                </span>
              ) : (
                <svg
                  className="ai-action-chip-check"
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="3 8.5 6.5 12 13 4" />
                </svg>
              )}
              <span className="ai-action-chip-text">{displayTitle(t)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="ai-process-drawer" id={drawerId} ref={drawerRef}>
        <div className="ai-process-timeline">
          {/* Thinking item */}
          {hasThinking && (
            <div className="ai-process-item is-thought">
              <div className="ai-process-item-content">
                <div className="ai-process-item-header">
                  <span className="ai-process-item-tag">Reasoning</span>
                  {thinking && (
                    <button
                      type="button"
                      className={`ai-process-copy-btn${copiedThinking ? ' copied' : ''}`}
                      onClick={copyReasoning}
                      title={copiedThinking ? 'Copied!' : 'Copy reasoning'}
                      aria-label="Copy reasoning"
                    >
                      {copiedThinking ? '✓ Copied' : 'Copy'}
                    </button>
                  )}
                </div>
                <div
                  ref={thoughtRef}
                  className="ai-process-thought-preview"
                  onScroll={onThoughtScroll}
                >
                  {visibleThinking}
                </div>
              </div>
            </div>
          )}

          {/* Tools items */}
          {tools.map((tool, idx) => {
            const hasDisplayData = Boolean(
              tool.display?.items?.length || (tool.display?.kind === 'text' && tool.display.text),
            )
            const hasOutput = !tool.running && (Boolean(tool.output) || hasDisplayData)
            const isToolOpen = expandedTools.has(idx)
            const statusClass = tool.running
              ? 'is-running'
              : tool.skipped
                ? 'is-skipped'
                : tool.isError
                  ? 'is-error'
                  : 'is-tool'
            const toolTitle = displayTitle(tool)
            const truncated = Boolean(tool.output && tool.output.length > TOOL_OUTPUT_RENDER_MAX)

            return (
              <div key={idx} className={`ai-process-item ${statusClass}`}>
                <div className="ai-process-item-content">
                  <div className="ai-process-item-header">
                    <span className="ai-process-tool-title">
                      {toolTitle}
                      {!tool.running && (
                        <span className="ai-process-item-state"> · {chipStatus(tool)}</span>
                      )}
                    </span>
                    {hasOutput && (
                      <button
                        type="button"
                        className="ai-process-toggle-btn"
                        aria-expanded={isToolOpen}
                        aria-label={`${toolTitle}: ${isToolOpen ? 'hide' : 'show'} details`}
                        onClick={() => toggleTool(idx)}
                      >
                        {isToolOpen ? 'Hide' : 'Details'}
                      </button>
                    )}
                  </div>

                  {/* Expandable tool output / technical details */}
                  {hasOutput && isToolOpen && (
                    <div className="ai-process-tool-output">
                      {tool.name && (
                        <div className="ai-process-tool-meta">
                          <span className="ai-process-tool-code">{tool.name}</span>
                        </div>
                      )}
                      {tool.display?.kind === 'links' && tool.display.items && (
                        <div className="ai-tool-output-links">
                          {tool.display.items.map((item, linkIdx) => {
                            const domain = getDomain(item.url)
                            return (
                              <div key={linkIdx} className="ai-tool-output-link-row">
                                <button
                                  type="button"
                                  className="ai-tool-output-link-btn"
                                  onClick={(e) => {
                                    e.preventDefault()
                                    onOpenExternalUrl?.(item.url)
                                  }}
                                  title={`${item.title || item.url}\n${item.url}`}
                                >
                                  <span className="ai-tool-link-icon" aria-hidden="true">
                                    🌐
                                  </span>
                                  {domain && <span className="ai-tool-link-domain">{domain}</span>}
                                  <span className="ai-tool-link-title">
                                    {item.title || item.url}
                                  </span>
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {tool.output && (
                        <pre className="ai-tool-output-pre">
                          {tool.output.slice(0, TOOL_OUTPUT_RENDER_MAX)}
                          {truncated ? '…' : ''}
                        </pre>
                      )}

                      {!tool.output && tool.display?.kind === 'text' && tool.display.text && (
                        <pre className="ai-tool-output-pre">
                          {tool.display.text.slice(0, TOOL_OUTPUT_RENDER_MAX)}
                          {tool.display.text.length > TOOL_OUTPUT_RENDER_MAX ? '…' : ''}
                        </pre>
                      )}

                      {truncated && tool.output && (
                        <div className="ai-process-truncation-note">
                          Showing the first {TOOL_OUTPUT_RENDER_MAX.toLocaleString('en-US')} of{' '}
                          {tool.output.length.toLocaleString('en-US')} characters.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {/* Active generation indicator while still streaming after tools have run */}
          {anyRunning && hasTools && !tools.some((t) => t.running) && (
            <div className="ai-process-item is-running">
              <div className="ai-process-item-content">
                <span className="ai-process-tool-summary">Generating response…</span>
              </div>
            </div>
          )}

          {/* Completion state: states the real outcome (never a green check for a
              failed or stopped run) and announces it once */}
          {!anyRunning && hasTools && (
            <div className={`ai-process-item ${footerKind === 'error' ? 'is-error' : 'is-done'}`}>
              <div className="ai-process-item-content">
                <span
                  className={`ai-process-done-label${footerKind === 'error' ? ' is-error' : footerKind === 'muted' ? ' is-muted' : ''}`}
                  role="status"
                >
                  {footerLabel}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
