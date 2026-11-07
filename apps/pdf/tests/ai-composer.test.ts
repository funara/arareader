import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AiComposer } from '@arareader/ui'

/**
 * R7: the compact composer hides the Enter/Shift+Enter hint visually, which used
 * to remove the guidance for screen-reader users too. The guidance must remain
 * available through the textarea's accessible description.
 */
const render = (iconOnly: boolean): string =>
  renderToStaticMarkup(
    createElement(AiComposer, {
      value: '',
      busy: false,
      placeholder: 'Ask ARA',
      hintIdle: 'Enter to send, Shift+Enter for newline',
      hintBusy: 'Esc to stop',
      sendLabel: 'Send',
      stopLabel: 'Stop',
      ariaLabel: 'Ask ARA',
      iconOnly,
      onChange: () => {},
      onSend: () => {},
      onStop: () => {},
    }),
  )

describe('AiComposer guidance (R7)', () => {
  it('keeps the shortcut hint as the textarea description in the icon-only composer', () => {
    const html = render(true)
    expect(html).toContain('aria-describedby=')
    expect(html).toContain('class="ai-sr-only"')
    expect(html).toContain('Enter to send, Shift+Enter for newline')
  })

  it('does not duplicate the hint when it is rendered visibly', () => {
    const html = render(false)
    expect(html).not.toContain('aria-describedby')
    expect(html).toContain('ai-input-hint')
    expect(html).toContain('Enter to send, Shift+Enter for newline')
  })

  it('names the send and stop buttons', () => {
    const html = render(true)
    expect(html).toContain('aria-label="Send"')
    // the input itself is labelled
    expect(html).toContain('aria-label="Ask ARA"')
  })
})
