// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportPagesAsPng } from '../src/renderer/export-png'

afterEach(() => vi.unstubAllGlobals())

describe('incremental PNG page rendering', () => {
  it('renders and awaits each page write in order without retaining earlier page payloads', async () => {
    let activePage = 0
    let pendingWrites = 0
    let maxPendingWrites = 0
    const pageRequests: number[] = []
    const canvas = {
      width: 0,
      height: 0,
      toDataURL: vi.fn(() => `data:image/png;base64,page-${activePage}`),
    }
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })

    const doc = {
      getPage: vi.fn(async (pageNumber: number) => {
        pageRequests.push(pageNumber)
        return {
          rotate: 90,
          getViewport: vi.fn(({ scale, rotation }: { scale: number; rotation: number }) => ({
            width: pageNumber * 10 * scale,
            height: pageNumber * 20 * scale,
            rotation,
          })),
          render: vi.fn(() => {
            activePage = pageNumber
            return { promise: Promise.resolve() }
          }),
        }
      }),
    }
    const writes: [number, string][] = []
    const writePage = vi.fn(async (index: number, image: string) => {
      pendingWrites++
      maxPendingWrites = Math.max(maxPendingWrites, pendingWrites)
      await Promise.resolve()
      writes.push([index, image])
      pendingWrites--
    })

    await exportPagesAsPng(
      doc,
      [2, 0, 1],
      (_pageIndex, pageRotation) => (pageRotation + 180) % 360,
      writePage,
    )

    expect(pageRequests).toEqual([3, 1, 2])
    expect(writes).toEqual([
      [0, 'page-3'],
      [1, 'page-1'],
      [2, 'page-2'],
    ])
    expect(maxPendingWrites).toBe(1)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })

  it('releases the canvas when a page write fails', async () => {
    const canvas = {
      width: 0,
      height: 0,
      toDataURL: vi.fn(() => 'data:image/png;base64,page'),
    }
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
    const doc = {
      getPage: vi.fn(async () => ({
        rotate: 0,
        getViewport: vi.fn(() => ({ width: 100, height: 100 })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
      })),
    }

    await expect(
      exportPagesAsPng(
        doc,
        [0],
        (_pageIndex, pageRotation) => pageRotation,
        async () => {
          throw new Error('write failed')
        },
      ),
    ).rejects.toThrow('write failed')
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })
})
