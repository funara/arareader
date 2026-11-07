import { describe, expect, it } from 'vitest'
import { wheelPageTurn, type WheelGesture } from '../src/renderer/wheel-paging'

const gesture = (): WheelGesture => ({ lastAt: 0, acc: 0, locked: false })
const event = (deltaY: number, deltaMode = 0, deltaX = 0) => ({ deltaX, deltaY, deltaMode })

describe('wheelPageTurn', () => {
  it('turns one page per pixel burst, then waits for the wheel to go quiet', () => {
    const g = gesture()
    expect(wheelPageTurn(g, event(100), 1_000, 800)).toBe(1)
    expect(wheelPageTurn(g, event(100), 1_010, 800)).toBeNull()
    expect(wheelPageTurn(g, event(60), 1_100, 800)).toBeNull()
    expect(wheelPageTurn(g, event(100), 1_300, 800)).toBe(1)
  })

  it('accumulates small trackpad deltas but ignores sub-threshold ones', () => {
    const g = gesture()
    expect(wheelPageTurn(g, event(10), 1_000, 800)).toBeNull()
    expect(wheelPageTurn(g, event(10), 1_010, 800)).toBe(1)
  })

  it('normalizes line- and page-mode deltas to pixels', () => {
    const lines = gesture()
    expect(wheelPageTurn(lines, event(1, 1), 1_000, 800)).toBeNull() // 16px
    expect(wheelPageTurn(lines, event(1, 1), 1_010, 800)).toBe(1) // 32px

    const pages = gesture()
    expect(wheelPageTurn(pages, event(1, 2), 1_000, 800)).toBe(1)
  })

  it('turns the other way on a direction reversal inside a burst', () => {
    const g = gesture()
    expect(wheelPageTurn(g, event(-100), 1_000, 800)).toBe(-1)
    expect(wheelPageTurn(g, event(100), 1_016, 800)).toBe(1)
  })

  it('ignores horizontal and zero-vertical wheel input', () => {
    const g = gesture()
    expect(wheelPageTurn(g, event(10, 0, 500), 1_000, 800)).toBeNull()
    expect(wheelPageTurn(g, event(0, 0, 500), 1_010, 800)).toBeNull()
    expect(g.acc).toBe(0)
    expect(g.locked).toBe(false)
  })

  it('stays locked through prolonged momentum', () => {
    const g = gesture()
    let now = 1_000
    expect(wheelPageTurn(g, event(80), now, 800)).toBe(1)
    for (let i = 0; i < 40; i++) {
      now += 16
      expect(wheelPageTurn(g, event(120), now, 800)).toBeNull()
    }
  })
})
