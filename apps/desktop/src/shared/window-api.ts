export interface WindowApi {
  /** true on Windows, where the frameless window's controls are drawn by the tab strip */
  readonly isWindows: boolean
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  isMaximized(): Promise<boolean>
  close(): Promise<void>
  openExternal(url: string): Promise<void>
  /** subscribe to maximize/restore; returns unsubscribe */
  onMaximizedChanged(handler: (maximized: boolean) => void): () => void
}

export const WINDOW_CHANNELS = {
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  isMaximized: 'window:is-maximized',
  close: 'window:close',
  stateChanged: 'window:state-changed',
  openExternal: 'window:open-external',
} as const
