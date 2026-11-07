import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiProcessCard, type AiProcessCardProps, type ToolActivityItem } from '@arareader/ui'

/**
 * R5 truthfulness: the compact activity card must state the real outcome of a
 * run. Every case here is a claim the card used to make unconditionally
 * ("✓ Completed" whenever nothing was running) or could not make at all
 * (skipped calls had no state).
 */

const render = (props: AiProcessCardProps): string =>
  renderToStaticMarkup(createElement(AiProcessCard, props))

const tool = (overrides: Partial<ToolActivityItem>): ToolActivityItem => ({
  name: 'read_pages',
  summary: 'Read pages 1-2',
  ...overrides,
})

describe('AiProcessCard outcomes (R5)', () => {
  it('does not claim completion when every action failed', () => {
    const html = render({
      tools: [tool({ summary: 'Edit page 1', isError: true })],
    })
    expect(html).not.toContain('✓ Completed')
    expect(html).toContain('Action failed')
    expect(html).toContain('is-error')
  })

  it('counts the failed actions when more than one ran and failed', () => {
    const html = render({
      tools: [tool({ isError: true }), tool({ summary: 'Edit page 1', isError: true })],
    })
    expect(html).not.toContain('✓ Completed')
    expect(html).toContain('2 actions failed')
  })

  it('says a stopped run was stopped, and that queued calls never ran', () => {
    const html = render({
      outcome: 'stopped',
      tools: [
        tool({ summary: 'Edited page 1', mutated: true }),
        tool({ summary: 'Delete page', isError: true, skipped: true }),
      ],
    })
    expect(html).not.toContain('✓ Completed')
    expect(html).toContain('Stopped · 1 not run')
    expect(html).toContain('1 of 2 steps completed')
    // the skipped chip carries the state in its accessible name, not colour alone
    expect(html).toContain('Delete page — not run')
    expect(html).toContain('is-skipped')
  })

  it('reports a mixed result without a green check', () => {
    const html = render({
      tools: [tool({ summary: 'Edited page 1', mutated: true }), tool({ isError: true })],
    })
    expect(html).not.toContain('✓ Completed')
    expect(html).toContain('1 of 2 steps completed')
    expect(html).toContain('Completed with 1 failed')
  })

  it('keeps the green check only for a run where every action succeeded', () => {
    const html = render({ tools: [tool({}), tool({ summary: 'Searched the web' })] })
    expect(html).toContain('✓ Completed')
    expect(html).toContain('2 steps completed')
  })

  it('states a failed outcome even when the actions themselves succeeded', () => {
    const html = render({ outcome: 'failed', tools: [tool({ summary: 'Edited page 1' })] })
    expect(html).not.toContain('✓ Completed')
    // collapsed header and footer agree: the run failed, the action landed
    expect(html).toContain('Failed after 1 completed action')
    expect(html).toContain('Failed after these actions')
  })

  it('marks a running action as working, never as completed', () => {
    const html = render({
      isStreaming: true,
      tools: [tool({ summary: 'Editing page 1', running: true })],
    })
    expect(html).not.toContain('✓ Completed')
    expect(html).toContain('Working: Editing page 1…')
  })
})

describe('AiProcessCard accessibility', () => {
  it('exposes chips as keyboard-operable buttons with a state in the name', () => {
    const html = render({ tools: [tool({ summary: 'Edited page 1', mutated: true })] })
    expect(html).toContain('<button')
    expect(html).toContain('aria-label="Edited page 1 — done"')
  })

  it('uses a real button for the process header instead of a fake role="button"', () => {
    const html = render({ tools: [tool({})] })
    expect(html).not.toContain('role="button"')
    expect(html).toMatch(/<button[^>]*class="ai-process-header"/)
    expect(html).toContain('aria-expanded="false"')
  })

  it('gives detail toggles a per-tool accessible name', () => {
    const html = render({
      tools: [tool({ summary: 'Edited page 1', output: 'ok' })],
    })
    expect(html).toContain('aria-label="Edited page 1: show details"')
  })
})

describe('AiProcessCard detail output', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const openFirstDetails = async (): Promise<void> => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    const details = buttons.find((b) => b.textContent === 'Details')
    expect(details).toBeTruthy()
    await act(async () => details!.click())
  }

  it('says when displayed output is truncated instead of ending in an ellipsis', async () => {
    const output = 'y'.repeat(4000)
    await act(async () => {
      root.render(createElement(AiProcessCard, { tools: [tool({ output })] }))
    })
    await openFirstDetails()
    expect(container.textContent).toContain('Showing the first 1,500 of 4,000 characters.')
  })

  it('renders a text display payload (previously computed but never shown)', async () => {
    await act(async () => {
      root.render(
        createElement(AiProcessCard, {
          tools: [
            tool({
              summary: 'Read webpage',
              output: undefined,
              display: { kind: 'text', text: 'page body' },
            }),
          ],
        }),
      )
    })
    await openFirstDetails()
    expect(container.querySelector('.ai-tool-output-pre')?.textContent).toContain('page body')
  })
})
