/** the tab strip's rendered height; applied inline in TabBar.tsx (overrides tabbar.css) */
export const TAB_STRIP_HEIGHT = 40

export type TabKind = 'home' | 'pdf'

/** one open tab in the top tab strip; Home is always id 'home' and not closable */
export interface TabSummary {
  id: string
  kind: TabKind
  title: string
  closable: boolean
  active: boolean
  reading?: boolean
  /** active PDF's paged/continuous view mode; absent means continuous */
  paged?: boolean
  spread?: 1 | 2
}

export interface TabsApi {
  list(): Promise<TabSummary[]>
  activate(id: string): Promise<void>
  close(id: string): Promise<void>
  /** move a tab to a new index in the strip; Home stays pinned at index 0 */
  reorder(id: string, toIndex: number): Promise<void>
  exitReadMode(): Promise<void>
  /** ask the active Read-mode PDF to use this view mode; it reports back through the tab list */
  setViewMode(paged: boolean): Promise<void>
  setSpread(spread: 1 | 2): Promise<void>
  /** subscribe to tab list changes (open/close/activate/title updates); returns unsubscribe */
  onChanged(handler: (tabs: TabSummary[]) => void): () => void
}

export const TABS_CHANNELS = {
  list: 'tabs:list',
  activate: 'tabs:activate',
  close: 'tabs:close',
  reorder: 'tabs:reorder',
  exitReadMode: 'tabs:exit-read-mode',
  setViewMode: 'tabs:set-view-mode',
  setSpread: 'tabs:set-spread',
  changed: 'tabs:changed',
} as const
