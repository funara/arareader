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
}

export interface TabsApi {
  list(): Promise<TabSummary[]>
  activate(id: string): Promise<void>
  close(id: string): Promise<void>
  /** move a tab to a new index in the strip; Home stays pinned at index 0 */
  reorder(id: string, toIndex: number): Promise<void>
  /** subscribe to tab list changes (open/close/activate/title updates); returns unsubscribe */
  onChanged(handler: (tabs: TabSummary[]) => void): () => void
}

export const TABS_CHANNELS = {
  list: 'tabs:list',
  activate: 'tabs:activate',
  close: 'tabs:close',
  reorder: 'tabs:reorder',
  changed: 'tabs:changed',
} as const
