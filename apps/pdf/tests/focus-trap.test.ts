import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trapTabKey } from '../src/renderer/focus-trap'

/**
 * The palette and the Organize grid are fixed masks over the whole window: a Tab that leaves
 * them lands on ribbon controls the user cannot see, so the trap is the guard.
 */

/** A keydown stub: jsdom does not run the default Tab move, which the trap must prevent */
function tab(shiftKey = false) {
  return { key: 'Tab', shiftKey, preventDefault: vi.fn() }
}

function overlay(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('trapTabKey', () => {
  it('wraps forward from the last control to the first', () => {
    const root = overlay('<button id="a">a</button><button id="b">b</button>')
    document.getElementById('b')!.focus()
    const e = tab()
    trapTabKey(e, root)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(document.activeElement).toBe(document.getElementById('a'))
  })

  it('wraps backward from the first control to the last', () => {
    const root = overlay('<button id="a">a</button><button id="b">b</button>')
    document.getElementById('a')!.focus()
    const e = tab(true)
    trapTabKey(e, root)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(document.activeElement).toBe(document.getElementById('b'))
  })

  it('leaves a Tab in the middle of the overlay to the browser', () => {
    const root = overlay('<button id="a">a</button><button id="b">b</button>')
    document.getElementById('a')!.focus()
    const e = tab()
    trapTabKey(e, root)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores disabled and tabindex="-1" controls and keys other than Tab', () => {
    const root = overlay(
      '<button id="a">a</button><button id="skip" disabled>skip</button>' +
        '<button id="m">m</button><span id="x" tabindex="-1">x</span>',
    )
    document.getElementById('m')!.focus()
    const e = tab()
    trapTabKey(e, root)
    // "m" is the last reachable control: the disabled button and the -1 span do not count
    expect(document.activeElement).toBe(document.getElementById('a'))

    document.getElementById('a')!.focus()
    const other = { key: 'ArrowDown', shiftKey: false, preventDefault: vi.fn() }
    trapTabKey(other, root)
    expect(other.preventDefault).not.toHaveBeenCalled()
  })

  it('pulls focus back in when it is outside the overlay', () => {
    document.body.innerHTML = '<button id="behind">behind</button>'
    const root = document.createElement('div')
    root.innerHTML = '<input id="only" />'
    document.body.append(root)
    document.getElementById('behind')!.focus()
    const e = tab()
    trapTabKey(e, root)
    expect(document.activeElement).toBe(document.getElementById('only'))
  })

  it('does nothing without a root', () => {
    const e = tab()
    trapTabKey(e, null)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})
