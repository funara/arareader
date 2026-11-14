import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../pdf/src/main/pdf-main', () => {
  let nextId = 0
  return {
    createPdfView: () => ({
      webContents: { id: ++nextId, isDestroyed: () => false },
      setVisible: vi.fn(),
      setBounds: vi.fn(),
    }),
    requestPdfClose: vi.fn(),
  }
})

import { TabManager } from '../src/main/tab-manager'

class DelayedWindow extends EventEmitter {
  fullscreen = false
  requests: boolean[] = []
  contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  isDestroyed = () => false
  isFullScreen = () => this.fullscreen
  getContentBounds = () => ({ x: 0, y: 0, width: 1000, height: 700 })
  setFullScreen = (value: boolean) => {
    this.requests.push(value)
  }
  async finish(value: boolean) {
    this.emit(value ? 'enter-full-screen' : 'leave-full-screen')
    this.fullscreen = value
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

describe('Read mode fullscreen transitions', () => {
  it('reconciles delayed transitions with tab switches without leaving Home fullscreen', async () => {
    const win = new DelayedWindow()
    const manager = new TabManager(win as unknown as BrowserWindow, () => {})
    const id = manager.openPdfTab('first.pdf')
    manager.setReadingFor(1, true)
    expect(win.requests).toEqual([true])
    manager.activateTab('home')
    await win.finish(true)
    expect(win.requests).toEqual([true, false])
    manager.activateTab(id)
    await win.finish(false)
    expect(win.requests).toEqual([true, false, true])
    await win.finish(true)
    manager.activateTab('home')
    expect(win.requests).toEqual([true, false, true, false])
    await win.finish(false)
    expect(win.fullscreen).toBe(false)
  })

  it('does not re-enter fullscreen after a manual exit or claim existing fullscreen', async () => {
    const win = new DelayedWindow()
    const manager = new TabManager(win as unknown as BrowserWindow, () => {})
    manager.openPdfTab('second.pdf')
    win.fullscreen = true
    manager.setReadingFor(2, true)
    expect(win.requests).toEqual([])
    manager.setReadingFor(2, false)
    expect(win.requests).toEqual([])
    win.fullscreen = false
    manager.setReadingFor(2, true)
    await win.finish(true)
    await win.finish(false)
    expect(win.requests).toEqual([true])
    manager.activateTab('home')
    expect(win.requests).toEqual([true])
  })
})
