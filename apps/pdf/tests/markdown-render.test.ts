import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@arareader/ui'

/**
 * Rendered-markup checks for R4: cell counts (so escaped/code pipes never add
 * columns), the keyboard-reachable scroll region, HTML escaping and the link
 * allowlist, and the long-answer truncation notice.
 */
const render = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))

const count = (html: string, tag: string): number =>
  html.split(new RegExp(`<${tag}[ >]`, 'g')).length - 1

describe('Markdown rendering (R4)', () => {
  it('renders borderless rows and escaped pipes as one cell per column', () => {
    const html = render('Name | Value\n--- | ---\nAlpha | 1\nGamma \\| Delta | 2')
    expect(count(html, 'th')).toBe(2)
    expect(count(html, 'td')).toBe(4)
    expect(html).toContain('Gamma | Delta')
    expect(html).toContain('Alpha')
  })

  it('renders a pipe inside a code span in the same cell', () => {
    const html = render('| Code | N |\n| --- | --- |\n| `a\\|b` | 2 |')
    expect(count(html, 'td')).toBe(2)
    expect(html).toContain('>a|b</code>')
  })

  it('gives the table wrapper a named, keyboard-reachable scroll region', () => {
    const html = render('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Table, horizontally scrollable"')
  })

  it('escapes model content and keeps the link allowlist', () => {
    const html = render('| A |\n| --- |\n| <img src=x onerror="alert(1)"> |')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')

    const unsafe = render('| Link |\n| --- |\n| [click](javascript:alert(1)) |')
    expect(unsafe).not.toContain('href')
    expect(unsafe).toContain('click')

    const safe = render('| Link |\n| --- |\n| [docs](https://example.com/x) |')
    expect(safe).toContain('href="https://example.com/x"')
    expect(safe).toContain('rel="noopener noreferrer"')
  })

  it('renders a partial streamed table without throwing', () => {
    expect(() => render('| A | B |\n|--')).not.toThrow()
    expect(render('| A | B |\n|--')).toContain('A')
  })

  it('shows a truncation notice and the omitted tail for long answers', () => {
    const many = Array.from({ length: 2102 }, (_, i) => `line ${i + 1}`).join('\n\n')
    const html = render(many)
    expect(html).toContain('<details')
    expect(html).toContain('Answer shortened after 2,000 blocks')
    expect(html).toContain('aria-label="Remaining answer content"')
    expect(html).toContain('line 1</p>')
    expect(html).toContain('line 2102')
  })
})
