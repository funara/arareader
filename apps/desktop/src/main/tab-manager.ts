import { basename } from 'node:path'
import type { BrowserWindow, Rectangle, WebContents, WebContentsView } from 'electron'
import { createPdfView, pdfIsDirty, requestPdfClose } from '../../../pdf/src/main/pdf-main'
import type { TabKind, TabSummary } from '../shared/tabs-api'
import { TAB_STRIP_HEIGHT } from '../shared/tabs-api'
import { normalizePathKey } from './recent-files'

interface TabRecord {
  id: string
  kind: TabKind
  /** null for the Home tab — the host renderer's own webContents draws it */
  view: WebContentsView | null
  title: string
  filePath?: string
}

const HOME_ID = 'home'

/**
 * Owns the home tab plus one WebContentsView per open PDF inside the host's
 * single BrowserWindow. Only the active view is visible; the home tab has no
 * view of its own, so hiding every PDF view reveals the host renderer.
 */
export class TabManager {
  private readonly tabs: TabRecord[] = [{ id: HOME_ID, kind: 'home', view: null, title: 'Home' }]
  private activeId: string = HOME_ID
  private nextId = 1
  /** tabs mid unsaved-changes prompt, so a second close click doesn't stack dialogs */
  private readonly closingIds = new Set<string>()

  constructor(
    private readonly window: BrowserWindow,
    private readonly onChanged: () => void,
  ) {
    // Layout once synchronously, then once more on the next tick: on Linux/X11
    // `resize` fires before the window manager applies the new size, so
    // getContentBounds() inside the handler can still be the old size.
    this.window.on('resize', () => {
      this.layout()
      setImmediate(() => this.layout())
    })
    this.window.on('focus', () => this.layout(true))
    this.window.on('show', () => this.layout(true))
    this.window.on('restore', () => this.layout(true))
  }

  private contentBounds(): Rectangle {
    const { width, height } = this.window.getContentBounds()
    return { x: 0, y: TAB_STRIP_HEIGHT, width, height: Math.max(0, height - TAB_STRIP_HEIGHT) }
  }

  private activeTab(): TabRecord | undefined {
    return this.tabs.find((tab) => tab.id === this.activeId)
  }

  /** raise `view` to the top of the window's view stack without leaving a duplicate child */
  private attachView(view: WebContentsView): void {
    const stack = this.window.contentView
    try {
      stack.removeChildView(view)
    } catch {
      /* not currently a child */
    }
    stack.addChildView(view)
  }

  /**
   * Re-fit every view after a window resize; background tabs keep their bounds
   * too, so a resize-then-switch never flashes a stale-sized view.
   */
  layout(force = false): void {
    if (this.window.isDestroyed()) return
    const bounds = this.contentBounds()
    for (const tab of this.tabs) {
      if (!tab.view || tab.view.webContents.isDestroyed()) continue
      try {
        tab.view.setBounds(bounds)
      } catch {
        /* ignore webContents errors during layout */
      }
    }
    const active = this.activeTab()
    if (!active?.view || active.view.webContents.isDestroyed()) return
    try {
      if (force) {
        this.attachView(active.view)
        active.view.setVisible(false)
      }
      active.view.setVisible(true)
      if (force) {
        active.view.webContents.invalidate()
        // Nudge bounds by 1px to force DelegatedFrameHost to reset its evicted frame buffer
        active.view.setBounds({ ...bounds, width: Math.max(0, bounds.width - 1) })
        active.view.setBounds(bounds)
      }
    } catch {
      /* ignore webContents errors during layout */
    }
  }

  list(): TabSummary[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      title: tab.title,
      closable: tab.id !== HOME_ID,
      active: tab.id === this.activeId,
    }))
  }

  openHomeTab(): void {
    this.activateTab(HOME_ID)
  }

  openPdfTab(openPath: string): string {
    const view = createPdfView(openPath)
    const id = `t${this.nextId++}`
    this.window.contentView.addChildView(view)
    view.setVisible(false)
    this.tabs.push({ id, kind: 'pdf', view, title: basename(openPath), filePath: openPath })
    this.activateTab(id)
    return id
  }

  activateTab(id: string): void {
    const target = this.tabs.find((tab) => tab.id === id)
    if (!target) return
    for (const tab of this.tabs) {
      if (tab.id !== id) tab.view?.setVisible(false)
    }
    if (target.view) {
      const bounds = this.contentBounds()
      this.attachView(target.view)
      target.view.setBounds({ ...bounds, width: Math.max(0, bounds.width - 1) })
      target.view.setBounds(bounds)
      target.view.setVisible(true)
    }
    this.activeId = id
    this.onChanged()
  }

  /** the focused PDF view's webContents, for File-menu commands routed into it */
  activePdfWebContents(): WebContents | null {
    const active = this.activeTab()
    return active?.kind === 'pdf' && active.view ? active.view.webContents : null
  }

  /** the file path a PDF view is currently bound to (undefined for Home/unknown views) */
  filePathForWebContents(id: number): string | undefined {
    return this.tabs.find((tab) => tab.view?.webContents.id === id)?.filePath
  }

  /** a PDF view saved to a new path (Save As) — re-title its tab and feed de-dupe */
  setTabFileFor(webContentsId: number, filePath: string): void {
    const tab = this.tabs.find((t) => t.view?.webContents.id === webContentsId)
    if (!tab) return
    tab.filePath = filePath
    tab.title = basename(filePath)
    this.onChanged()
  }

  findPdfTabByPath(path: string): string | undefined {
    const key = normalizePathKey(path)
    return this.tabs.find(
      (tab) =>
        tab.kind === 'pdf' && tab.filePath !== undefined && normalizePathKey(tab.filePath) === key,
    )?.id
  }

  /** PDF tabs whose renderer reports unsaved markups/form edits (close guard) */
  dirtyPdfTabs(): Array<{ id: string; webContents: WebContents }> {
    const dirty: Array<{ id: string; webContents: WebContents }> = []
    for (const tab of this.tabs) {
      if (tab.kind === 'pdf' && tab.view && pdfIsDirty(tab.view.webContents.id)) {
        dirty.push({ id: tab.id, webContents: tab.view.webContents })
      }
    }
    return dirty
  }

  /** move a tab to a new index in the strip; Home is pinned at index 0 */
  reorder(id: string, toIndex: number): void {
    if (id === HOME_ID) return
    const fromIndex = this.tabs.findIndex((tab) => tab.id === id)
    if (fromIndex < 0) return
    const clamped = Math.min(Math.max(Math.trunc(toIndex), 1), this.tabs.length - 1)
    if (clamped === fromIndex) return
    const [moved] = this.tabs.splice(fromIndex, 1)
    this.tabs.splice(clamped, 0, moved)
    this.onChanged()
  }

  /** closes whichever tab is currently active; no-op for Home (Cmd+W target) */
  closeActiveTab(): void {
    void this.closeTab(this.activeId)
  }

  async closeTab(id: string): Promise<void> {
    if (id === HOME_ID) return
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab || this.closingIds.has(id)) return
    if (tab.view && pdfIsDirty(tab.view.webContents.id)) {
      // Bring the tab into view so the save prompt has visible context.
      if (this.activeId !== id) this.activateTab(id)
      this.closingIds.add(id)
      try {
        if (!(await requestPdfClose(tab.view.webContents, this.window))) return
      } finally {
        this.closingIds.delete(id)
      }
    }
    const index = this.tabs.findIndex((t) => t.id === id)
    if (index < 0) return
    const [removed] = this.tabs.splice(index, 1)
    if (this.activeId === id) {
      const fallback = this.tabs[index - 1] ?? this.tabs[0]
      this.activateTab(fallback.id)
    } else {
      this.onChanged()
    }
    if (removed.view) {
      removed.view.setVisible(false)
      this.window.contentView.removeChildView(removed.view)
      removed.view.webContents.close()
    }
  }
}
