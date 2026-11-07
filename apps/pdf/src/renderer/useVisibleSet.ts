import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** Which items in the container are within the (expanded) viewport — shared lazy-render basis
    for pages/thumbnails. Rebuild the observer when enabled flips (sidebar toggles unmount/remount the root) */
export function useVisibleSet(
  rootRef: RefObject<HTMLElement | null>,
  count: number,
  rootMargin: string,
  enabled = true,
): { visible: Set<number>; setItemRef: (idx: number) => (el: HTMLElement | null) => void } {
  const [visible, setVisible] = useState<Set<number>>(new Set())
  const itemRefs = useRef<(HTMLElement | null)[]>([])
  const ioRef = useRef<IntersectionObserver | null>(null)
  // Stable per-index ref callbacks. A fresh callback each render makes React detach and
  // re-attach every item, and each re-observe fires the observer again — a render loop.
  const setterRefs = useRef(new Map<number, (el: HTMLElement | null) => void>())
  useEffect(() => {
    const root = rootRef.current
    if (!enabled || !root || count === 0) return
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          let next: Set<number> | null = null
          for (const e of entries) {
            const idx = Number((e.target as HTMLElement).dataset.idx)
            if (e.isIntersecting === prev.has(idx)) continue
            if (!next) next = new Set(prev)
            if (e.isIntersecting) next.add(idx)
            else next.delete(idx)
          }
          // Unchanged membership must not re-render: observers report on every re-observe
          return next ?? prev
        })
      },
      { root, rootMargin },
    )
    ioRef.current = io
    for (const el of itemRefs.current) if (el) io.observe(el)
    return () => {
      io.disconnect()
      ioRef.current = null
    }
  }, [rootRef, count, rootMargin, enabled])

  const setItemRef = useCallback((idx: number) => {
    let setter = setterRefs.current.get(idx)
    if (!setter) {
      setter = (el) => {
        const prev = itemRefs.current[idx]
        if (prev === el) return
        if (prev) ioRef.current?.unobserve(prev)
        itemRefs.current[idx] = el
        if (el) ioRef.current?.observe(el)
      }
      setterRefs.current.set(idx, setter)
    }
    return setter
  }, [])

  return { visible, setItemRef }
}
