import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  HomeApi,
  NewPdfResult,
  ReaderPreferences,
  RecentPage,
  UiLanguage,
} from '../shared/home-api'
import { HOME_CHANNELS } from '../shared/home-api'
import type { AppUpdateState, ChangelogEntry } from '../shared/update-api'
import type { TabsApi, TabSummary } from '../shared/tabs-api'
import { TABS_CHANNELS } from '../shared/tabs-api'
import type { WindowApi } from '../shared/window-api'
import { WINDOW_CHANNELS } from '../shared/window-api'
import type { FetchModelsResult, ReaderAiApi, ReaderProjectApi } from '../shared/ai-api'
import { AI_CHANNELS, PROJECT_CHANNELS } from '../shared/ai-api'

const EMPTY_PAGE: RecentPage = { entries: [], total: 0, totalAll: 0 }

function asRecentPage(result: unknown): RecentPage {
  if (result && typeof result === 'object' && Array.isArray((result as RecentPage).entries)) {
    return result as RecentPage
  }
  return EMPTY_PAGE
}

/** never trust an IPC payload: anything unexpected surfaces as a plain failure */
function asNewPdfResult(result: unknown): NewPdfResult {
  if (!result || typeof result !== 'object') return { ok: false, error: 'Invalid response.' }
  const value = result as { ok?: unknown; path?: unknown; canceled?: unknown; error?: unknown }
  if (value.ok === true && typeof value.path === 'string') return { ok: true, path: value.path }
  if (value.ok === true && value.canceled === true) return { ok: true, canceled: true }
  if (value.ok === false && typeof value.error === 'string') {
    return { ok: false, error: value.error }
  }
  return { ok: false, error: 'Invalid response.' }
}

/** model lists arrive from an arbitrary endpoint: keep only the string ids */
function asFetchModelsResult(result: unknown): FetchModelsResult {
  if (!result || typeof result !== 'object') {
    return { ok: false, models: [], error: 'Invalid response.' }
  }
  const value = result as { ok?: unknown; models?: unknown; error?: unknown }
  const models = Array.isArray(value.models)
    ? value.models.filter((model): model is string => typeof model === 'string' && model !== '')
    : []
  if (value.ok === true) return { ok: true, models }
  return {
    ok: false,
    models,
    error: typeof value.error === 'string' ? value.error : 'Could not fetch models.',
  }
}

const homeApi: HomeApi = {
  async recents(query) {
    return asRecentPage(await ipcRenderer.invoke(HOME_CHANNELS.recents, query))
  },
  async openPath(path) {
    if (typeof path !== 'string' || !path) throw new Error('Invalid path.')
    await ipcRenderer.invoke(HOME_CHANNELS.openPath, path)
  },
  async openPdf() {
    await ipcRenderer.invoke(HOME_CHANNELS.openPdf)
  },
  async newPdf() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.newPdf)
    return asNewPdfResult(result)
  },
  async browse() {
    await ipcRenderer.invoke(HOME_CHANNELS.browse)
  },
  async removeRecent(paths) {
    await ipcRenderer.invoke(HOME_CHANNELS.removeRecent, paths)
  },
  async revealPath(path) {
    if (typeof path !== 'string' || !path) throw new Error('Invalid path.')
    await ipcRenderer.invoke(HOME_CHANNELS.revealPath, path)
  },
  async getLanguage() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getLanguage)
    return (typeof result === 'string' ? result : 'en') as UiLanguage
  },
  async setLanguage(lang) {
    await ipcRenderer.invoke(HOME_CHANNELS.setLanguage, lang)
  },
  async getTheme() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getTheme)
    return result === 'dark' || result === 'light' ? result : 'system'
  },
  async setTheme(theme) {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') {
      throw new Error('Invalid theme.')
    }
    await ipcRenderer.invoke(HOME_CHANNELS.setTheme, theme)
  },
  async getPreferences() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getPreferences)
    return result as ReaderPreferences
  },
  async setPreferences(prefs) {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.setPreferences, prefs)
    return result as ReaderPreferences
  },
  onPreferencesChanged(handler) {
    const listener = (_event: IpcRendererEvent, prefs: ReaderPreferences) => handler(prefs)
    ipcRenderer.on(HOME_CHANNELS.preferencesChanged, listener)
    return () => ipcRenderer.removeListener(HOME_CHANNELS.preferencesChanged, listener)
  },
  async getAppVersion() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getAppVersion)
    return typeof result === 'string' ? result : ''
  },
  async getUpdateState() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getUpdateState)
    return (
      result && typeof result === 'object' ? result : { status: 'idle', currentVersion: '' }
    ) as AppUpdateState
  },
  async checkForUpdates() {
    await ipcRenderer.invoke(HOME_CHANNELS.checkForUpdates)
  },
  async restartAndInstall() {
    await ipcRenderer.invoke(HOME_CHANNELS.restartAndInstall)
  },
  async getChangelog() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getChangelog)
    return Array.isArray(result) ? (result as ChangelogEntry[]) : []
  },
  async getJustUpdated() {
    const result: unknown = await ipcRenderer.invoke(HOME_CHANNELS.getJustUpdated)
    return result === true
  },
  async clearJustUpdated() {
    await ipcRenderer.invoke(HOME_CHANNELS.clearJustUpdated)
  },
  onUpdateStateChanged(handler) {
    const listener = (_event: IpcRendererEvent, state: AppUpdateState) => handler(state)
    ipcRenderer.on(HOME_CHANNELS.updateStateChanged, listener)
    return () => ipcRenderer.removeListener(HOME_CHANNELS.updateStateChanged, listener)
  },
}

contextBridge.exposeInMainWorld('reader', homeApi)

const tabsApi: TabsApi = {
  async list() {
    const result: unknown = await ipcRenderer.invoke(TABS_CHANNELS.list)
    return Array.isArray(result) ? (result as TabSummary[]) : []
  },
  async activate(id) {
    await ipcRenderer.invoke(TABS_CHANNELS.activate, id)
  },
  async close(id) {
    await ipcRenderer.invoke(TABS_CHANNELS.close, id)
  },
  async reorder(id, toIndex) {
    await ipcRenderer.invoke(TABS_CHANNELS.reorder, id, toIndex)
  },
  async exitReadMode() {
    await ipcRenderer.invoke(TABS_CHANNELS.exitReadMode)
  },
  async setViewMode(paged) {
    await ipcRenderer.invoke(TABS_CHANNELS.setViewMode, paged)
  },
  onChanged(handler) {
    const listener = (_event: IpcRendererEvent, tabs: TabSummary[]) => handler(tabs)
    ipcRenderer.on(TABS_CHANNELS.changed, listener)
    return () => ipcRenderer.removeListener(TABS_CHANNELS.changed, listener)
  },
}

contextBridge.exposeInMainWorld('readerTabs', tabsApi)

const windowApi: WindowApi = {
  isWindows: navigator.userAgent.includes('Windows'),
  async minimize() {
    await ipcRenderer.invoke(WINDOW_CHANNELS.minimize)
  },
  async toggleMaximize() {
    await ipcRenderer.invoke(WINDOW_CHANNELS.toggleMaximize)
  },
  async isMaximized() {
    return (await ipcRenderer.invoke(WINDOW_CHANNELS.isMaximized)) === true
  },
  async close() {
    await ipcRenderer.invoke(WINDOW_CHANNELS.close)
  },
  async openExternal(url) {
    await ipcRenderer.invoke(WINDOW_CHANNELS.openExternal, url)
  },
  onMaximizedChanged(handler) {
    const listener = (_event: IpcRendererEvent, maximized: boolean) => handler(maximized)
    ipcRenderer.on(WINDOW_CHANNELS.stateChanged, listener)
    return () => ipcRenderer.removeListener(WINDOW_CHANNELS.stateChanged, listener)
  },
}

contextBridge.exposeInMainWorld('readerWindow', windowApi)

// Settings reads are redacted by main: the renderer sees hasApiKey, never apiKey.
const aiApi: ReaderAiApi = {
  async getSettings() {
    return ipcRenderer.invoke(AI_CHANNELS.getSettings)
  },
  async setSettings(settings) {
    await ipcRenderer.invoke(AI_CHANNELS.setSettings, settings)
  },
  async fetchCustomModels(override) {
    return asFetchModelsResult(await ipcRenderer.invoke(AI_CHANNELS.fetchCustomModels, override))
  },
  async configure() {
    await ipcRenderer.invoke(AI_CHANNELS.configure)
  },
  onSettingsChanged(handler) {
    const listener = (_event: IpcRendererEvent, settings: Parameters<typeof handler>[0]) =>
      handler(settings)
    ipcRenderer.on(AI_CHANNELS.settingsChanged, listener)
    return () => ipcRenderer.removeListener(AI_CHANNELS.settingsChanged, listener)
  },
  onConfigureRequest(handler) {
    const listener = () => handler()
    ipcRenderer.on(AI_CHANNELS.configureRequest, listener)
    return () => ipcRenderer.removeListener(AI_CHANNELS.configureRequest, listener)
  },
}

contextBridge.exposeInMainWorld('readerAi', aiApi)

// Per-document chat history: one chat per PDF path, so reopening a file restores
// its transcript. Resolve/append/load/rebind only (no project list management).
const projectApi: ReaderProjectApi = {
  async resolveChat(args) {
    return ipcRenderer.invoke(PROJECT_CHANNELS.resolveChat, args)
  },
  async appendChat(args) {
    return ipcRenderer.invoke(PROJECT_CHANNELS.appendChat, args)
  },
  async loadChat(args) {
    return ipcRenderer.invoke(PROJECT_CHANNELS.loadChat, args)
  },
  async rebindChat(args) {
    return ipcRenderer.invoke(PROJECT_CHANNELS.rebindChat, args)
  },
}

contextBridge.exposeInMainWorld('readerProject', projectApi)

// OS file drops on the home/tab strip open PDF tabs. Drops inside a PDF view
// are handled by that view's own preload, which forwards to the host.
function droppedPdfPaths(event: DragEvent): string[] {
  const files = Array.from(event.dataTransfer?.files ?? [])
  return files
    .map((file) => webUtils.getPathForFile(file))
    .filter((path) => path !== '' && /\.pdf$/i.test(path))
}

window.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
})
window.addEventListener('drop', (event) => {
  const paths = droppedPdfPaths(event)
  if (paths.length === 0) return
  event.preventDefault()
  for (const path of paths) void ipcRenderer.invoke(HOME_CHANNELS.openPath, path)
})
