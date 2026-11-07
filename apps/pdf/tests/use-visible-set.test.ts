import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVisibleSet } from '../src/renderer/useVisibleSet'

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  static observeCalls = 0

  root = null
  rootMargin = ''
  thresholds = []
  observed = new Set<Element>()

  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }

  observe(el: Element): void {
    FakeIntersectionObserver.observeCalls++
    this.observed.add(el)
  }
  unobserve(el: Element): void {
    this.observed.delete(el)
  }
  disconnect(): void {
    this.observed.clear()
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  trigger(entries: Array<{ target: Element; isIntersecting: boolean }>): void {
    this.cb(
      entries as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    )
  }
}

let lastVisible: Set<number> | null = null
const rootRef = createRef<HTMLDivElement>()

function Harness({ count }: { count: number }) {
  const { visible, setItemRef } = useVisibleSet(rootRef, count, '0px')
  lastVisible = visible
  return createElement(
    'div',
    { ref: rootRef },
    Array.from({ length: count }, (_, i) =>
      createElement('div', {
        key: i,
        ref: setItemRef(i),
        'data-idx': i,
        'data-visible': visible.has(i) ? '1' : '0',
      }),
    ),
  )
}

describe('useVisibleSet', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    lastVisible = null
    FakeIntersectionObserver.instances = []
    FakeIntersectionObserver.observeCalls = 0
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('observes each item once and keeps the callbacks stable across re-renders', () => {
    act(() => root.render(createElement(Harness, { count: 2 })))
    expect(FakeIntersectionObserver.observeCalls).toBe(2)
    expect(FakeIntersectionObserver.instances[0]!.observed.size).toBe(2)

    act(() => root.render(createElement(Harness, { count: 2 })))
    // A new callback identity would detach/re-attach every item, re-observe it, and loop
    expect(FakeIntersectionObserver.observeCalls).toBe(2)
  })

  it('replaces the visible set only when membership actually changes', () => {
    act(() => root.render(createElement(Harness, { count: 2 })))
    const io = FakeIntersectionObserver.instances[0]!
    const first = container.querySelector('[data-idx="0"]')!
    const second = container.querySelector('[data-idx="1"]')!

    act(() => io.trigger([{ target: first, isIntersecting: true }]))
    const afterFirst = lastVisible
    expect(afterFirst!.has(0)).toBe(true)
    expect(first.getAttribute('data-visible')).toBe('1')

    // Observers report on every re-observe; unchanged membership must keep the same Set
    act(() => io.trigger([{ target: first, isIntersecting: true }]))
    expect(lastVisible).toBe(afterFirst)
    act(() => io.trigger([{ target: second, isIntersecting: false }]))
    expect(lastVisible).toBe(afterFirst)

    act(() => io.trigger([{ target: first, isIntersecting: false }]))
    expect(lastVisible).not.toBe(afterFirst)
    expect(lastVisible!.has(0)).toBe(false)
    expect(first.getAttribute('data-visible')).toBe('0')
  })
})
