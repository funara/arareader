import { describe, expect, it } from 'vitest'
import { navAction, ownsNavKeys } from '../src/renderer/keyNav'

describe('navAction', () => {
  it('steps a whole page on ArrowDown/ArrowUp when focus is in the thumbnail sidebar', () => {
    expect(navAction('ArrowDown', true)).toEqual({ type: 'stepPage', dir: 1 })
    expect(navAction('ArrowUp', true)).toEqual({ type: 'stepPage', dir: -1 })
  })

  it('scrolls by 60px on ArrowDown/ArrowUp when focus is outside the sidebar', () => {
    expect(navAction('ArrowDown', false)).toEqual({ type: 'scrollBy', delta: 60 })
    expect(navAction('ArrowUp', false)).toEqual({ type: 'scrollBy', delta: -60 })
  })

  it('steps a whole page on ArrowRight/ArrowLeft regardless of focus', () => {
    expect(navAction('ArrowRight', false)).toEqual({ type: 'stepPage', dir: 1 })
    expect(navAction('ArrowLeft', false)).toEqual({ type: 'stepPage', dir: -1 })
    expect(navAction('ArrowRight', true)).toEqual({ type: 'stepPage', dir: 1 })
    expect(navAction('ArrowLeft', true)).toEqual({ type: 'stepPage', dir: -1 })
  })

  it('scrolls a viewport on PageDown/Space/PageUp', () => {
    expect(navAction('PageDown', false)).toEqual({ type: 'scrollViewport', dir: 1 })
    expect(navAction(' ', false)).toEqual({ type: 'scrollViewport', dir: 1 })
    expect(navAction('PageUp', false)).toEqual({ type: 'scrollViewport', dir: -1 })
  })

  it('jumps to the edges on Home/End', () => {
    expect(navAction('Home', false)).toEqual({ type: 'scrollEdge', edge: 'top' })
    expect(navAction('End', false)).toEqual({ type: 'scrollEdge', edge: 'bottom' })
  })

  it('returns null for keys it does not handle', () => {
    expect(navAction('a', false)).toBeNull()
    expect(navAction('Enter', true)).toBeNull()
    expect(navAction('Tab', false)).toBeNull()
  })
})

describe('ownsNavKeys (focused scroll regions keep their arrow keys)', () => {
  const box = (tabIndex: string | null, overflow: string, scrollWidth = 0): HTMLElement => {
    const el = document.createElement('div')
    if (tabIndex !== null) el.setAttribute('tabindex', tabIndex)
    el.style.overflowX = overflow
    Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true })
    Object.defineProperty(el, 'clientWidth', { value: 200, configurable: true })
    return el
  }

  it('lets a focusable, overflowing region own the navigation keys', () => {
    expect(ownsNavKeys(box('0', 'auto', 640))).toBe(true)
  })

  it('ignores elements that are not explicitly focusable (buttons, prose)', () => {
    expect(ownsNavKeys(box(null, 'auto', 640))).toBe(false)
  })

  it('ignores a focusable element that does not overflow', () => {
    expect(ownsNavKeys(box('0', 'auto', 120))).toBe(false)
  })

  it('ignores a focusable element that cannot scroll', () => {
    expect(ownsNavKeys(box('0', 'hidden', 640))).toBe(false)
  })

  it('is safe with no target', () => {
    expect(ownsNavKeys(null)).toBe(false)
  })
})
