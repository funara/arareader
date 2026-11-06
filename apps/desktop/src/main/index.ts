import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  webContents,
} from 'electron'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import {
  appMenuLabels,
  atomicWriteFile,
  contextMenuLabels,
  editMenuTemplate,
  installContextMenu,
  installNavigationGuard,
  safeExternalUrl,
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  viewMenuTemplate,
  windowMenuTemplate,
} from '@arareader/electron-utils'
import { isLang, normalizeLang, setUiLang, type Lang } from '@arareader/i18n'
import {
  configurePdfRuntime,
  requestPdfClose,
  setPdfFileSavedHook,
  setPdfOpenPathHandler,
} from '../../../pdf/src/main/pdf-main'
import { PDF_CHANNELS } from '../../../pdf/src/shared/ipc'
import type { PdfMenuCommand } from '../../../pdf/src/shared/ipc'
import { projectFileRenamed, registerAiBridge } from './ai-bridge'
import { readAppSettings, writeAppSetting } from './app-settings'
import { createBlankPdfBytes } from './blank-pdf'
import { readRecentPage, recordRecentFile, removeRecentFiles } from './recent-files'
import { TabManager } from './tab-manager'
import {
  checkForUpdates,
  clearJustUpdated,
  fetchChangelog,
  getAppUpdateState,
  getJustUpdated,
  initAutoUpdater,
  restartAndInstall,
} from './updater'
import { AI_CHANNELS } from '../shared/ai-api'
import {
  HOME_CHANNELS,
  type NewPdfResult,
  type ReaderPreferences,
  type SavedSignature,
  type UiTheme,
  type UserProfile,
} from '../shared/home-api'
import { TABS_CHANNELS } from '../shared/tabs-api'
import { WINDOW_CHANNELS } from '../shared/window-api'

/**
 * ARAReader desktop host: ONE Electron app, ONE BrowserWindow, PDFs hosted as
 * WebContentsView tabs behind a home/tab-strip renderer. The host owns the
 * lifecycle — single-instance lock, .pdf routing, menus, recents, and the
 * dirty-close prompts — while apps/pdf owns everything inside a PDF view.
 */

app.setName('ARAReader')

// A dev run must not share the installed app's userData or single-instance lock,
// otherwise it silently quits and forwards its argv to the running app.
if (!app.isPackaged)
  app.setPath(
    'userData',
    process.env.ARAREADER_USER_DATA ?? join(app.getPath('appData'), 'ARAReader Dev'),
  )

const APPS_ROOT = join(app.getAppPath(), '..')
// module build outputs: packaged builds carry them as resources/modules/pdf
const PDF_OUT = app.isPackaged
  ? join(process.resourcesPath, 'modules', 'pdf')
  : join(APPS_ROOT, 'pdf', 'out')

// Square app mark: window/taskbar icon in dev; packaged builds provide it as a
// resource (M4) at the same name.
const APP_ICON_PATH = app.isPackaged
  ? join(process.resourcesPath, 'ARAReader-icon.png')
  : join(app.getAppPath(), '..', '..', 'public', 'ARAReader-icon.png')

/**
 * Renderer origin for an unpacked (dev) run: PDF_RENDERER_URL when set, else
 * the documented dev port while the PDF renderer has no build output. Packaged
 * runs and built runs load the built index.html.
 */
function devUrl(envName: string, port: number, builtFile: string): string | undefined {
  if (app.isPackaged) return undefined
  const configured = process.env[envName]
  if (configured) return configured
  return existsSync(builtFile) ? undefined : `http://localhost:${port}`
}

configurePdfRuntime({
  preloadPath: join(PDF_OUT, 'preload', 'index.js'),
  rendererUrl: devUrl('PDF_RENDERER_URL', 5176, join(PDF_OUT, 'renderer', 'index.html')),
  rendererFile: join(PDF_OUT, 'renderer', 'index.html'),
})

// ---- UI language / theme ----
// Persisted in userData/app-settings.json; the shared i18n UI lang is set too so
// the PDF module (same main process) answers pdf:get-language consistently.

const APP_SETTINGS_PATH = (): string => join(app.getPath('userData'), 'app-settings.json')
const RECENT_FILE = (): string => join(app.getPath('userData'), 'recent.json')

let uiLang: Lang | null = null
let cachedTheme: UiTheme | null = null

function currentLang(): Lang {
  if (!uiLang) {
    uiLang = process.env.ARAREADER_LANG
      ? normalizeLang(process.env.ARAREADER_LANG)
      : normalizeLang(app.getLocale())
  }
  setUiLang(uiLang)
  return uiLang
}

function persistLang(lang: Lang): void {
  uiLang = lang
  setUiLang(lang)
  void writeAppSetting(APP_SETTINGS_PATH(), 'language', lang).catch((err) =>
    console.error('[desktop] language write failed:', err),
  )
}

function currentTheme(): UiTheme {
  cachedTheme ??= 'system'
  return cachedTheme
}

async function primeUiSettings(): Promise<void> {
  const settings = await readAppSettings(APP_SETTINGS_PATH())
  if (isLang(settings.language)) uiLang = settings.language
  if (settings.theme === 'light' || settings.theme === 'dark') cachedTheme = settings.theme
}

function normalizeProfile(raw: unknown): UserProfile {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const displayName = typeof obj.displayName === 'string' ? obj.displayName.trim().slice(0, 80) : ''
  return {
    displayName,
    fullName: typeof obj.fullName === 'string' ? obj.fullName.trim().slice(0, 120) : '',
    title: typeof obj.title === 'string' ? obj.title.trim().slice(0, 120) : '',
    organization: typeof obj.organization === 'string' ? obj.organization.trim().slice(0, 120) : '',
    email: typeof obj.email === 'string' ? obj.email.trim().slice(0, 120) : '',
    useAsDefaultAuthor: obj.useAsDefaultAuthor !== false,
  }
}

function normalizeSignatures(raw: unknown): SavedSignature[] {
  if (!Array.isArray(raw)) return []
  const out: SavedSignature[] = []
  for (const item of raw.slice(0, 24)) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : ''
    const label =
      typeof rec.label === 'string' && rec.label.trim()
        ? rec.label.trim().slice(0, 60)
        : 'Signature'
    const kind = rec.kind === 'strokes' || rec.kind === 'image' ? rec.kind : null
    const width = typeof rec.width === 'number' && rec.width > 0 ? rec.width : 420
    const height = typeof rec.height === 'number' && rec.height > 0 ? rec.height : 150
    if (!id || !kind) continue
    if (kind === 'strokes' && Array.isArray(rec.paths)) {
      const paths = rec.paths
        .filter((p): p is number[] => Array.isArray(p) && p.every((n) => typeof n === 'number'))
        .slice(0, 200)
      const color: [number, number, number] | undefined =
        Array.isArray(rec.color) &&
        rec.color.length === 3 &&
        rec.color.every((c) => typeof c === 'number')
          ? [rec.color[0] as number, rec.color[1] as number, rec.color[2] as number]
          : undefined
      out.push({
        id,
        label,
        kind: 'strokes',
        paths,
        width,
        height,
        color,
        createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : Date.now(),
        isDefault: rec.isDefault === true,
      })
    } else if (kind === 'image' && typeof rec.image === 'string' && rec.image.length > 0) {
      out.push({
        id,
        label,
        kind: 'image',
        image: rec.image,
        width,
        height,
        createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : Date.now(),
        isDefault: rec.isDefault === true,
      })
    }
  }
  return out
}

function normalizePreferences(raw: unknown): ReaderPreferences {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const starredPaths = Array.isArray(obj.starredPaths)
    ? obj.starredPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []
  const defaultZoom =
    obj.defaultZoom === 'fit-width' ||
    obj.defaultZoom === 'fit-page' ||
    obj.defaultZoom === '100' ||
    obj.defaultZoom === '125'
      ? obj.defaultZoom
      : 'fit-width'
  const defaultSidebar =
    obj.defaultSidebar === 'none' ||
    obj.defaultSidebar === 'thumbs' ||
    obj.defaultSidebar === 'outline'
      ? obj.defaultSidebar
      : 'none'
  return {
    profile: normalizeProfile(obj.profile),
    signatures: normalizeSignatures(obj.signatures),
    starredPaths,
    defaultZoom,
    defaultSidebar,
    autosave: obj.autosave === true,
    aiAutoSuggestions: obj.aiAutoSuggestions !== false,
    onboardingCompleted: obj.onboardingCompleted === true,
  }
}

async function readPreferences(): Promise<ReaderPreferences> {
  const settings = await readAppSettings(APP_SETTINGS_PATH())
  return normalizePreferences(settings.userPreferences)
}

async function writePreferences(next: unknown): Promise<ReaderPreferences> {
  const normalized = normalizePreferences(next)
  await writeAppSetting(APP_SETTINGS_PATH(), 'userPreferences', normalized)
  broadcast(HOME_CHANNELS.preferencesChanged, normalized)
  return normalized
}

function broadcast(channel: string, payload: unknown): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue
    try {
      contents.send(channel, payload)
    } catch {
      /* frame disposed */
    }
  }
}

// ---- window + tabs ----

let mainWindow: BrowserWindow | null = null
let tabManager: TabManager | null = null

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function recordRecent(filePath: string): void {
  void recordRecentFile(RECENT_FILE(), filePath).catch((err) =>
    console.error('[desktop] recent write failed:', err),
  )
  // OS jump lists / dock recents; Linux has no equivalent, and older desktops
  // may not implement it, so registration is best-effort only.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      app.addRecentDocument(filePath)
    } catch {
      /* ignore OS recent documents registration failure */
    }
  }
}

const PDF_RE = /\.pdf$/i

const REPO_URL = 'https://github.com/funara/arareader'

/** validate + dedupe by path, open a PDF tab, and record it as recent */
async function openDocumentPath(rawPath: string): Promise<boolean> {
  const trimmed = typeof rawPath === 'string' ? rawPath.trim() : ''
  // argv / open-file paths can be relative to the launching CWD; the recents
  // list and tab dedupe both need one canonical form.
  const filePath = trimmed ? resolve(trimmed) : ''
  if (!filePath || !PDF_RE.test(filePath) || !tabManager || !(await pathExists(filePath))) {
    return false
  }
  recordRecent(filePath)
  const existing = tabManager.findPdfTabByPath(filePath)
  if (existing) tabManager.activateTab(existing)
  else tabManager.openPdfTab(filePath)
  return true
}

/** the PDF file picker shared by File > Open and the home screen's Open/Browse */
async function openPdfViaDialog(): Promise<void> {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow()
  if (!win) return
  const result = await showOpenDialogWithMemory(dialog, win, {
    title: 'Open PDF',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
    properties: ['openFile'],
  })
  const picked = result.filePaths[0]
  if (!result.canceled && picked) await openDocumentPath(picked)
}

/**
 * New PDF: the same Save-As picker as the PDF module, then a blank one-page
 * file on disk and in a tab. Failures are returned, not thrown — the home
 * screen owns the error banner.
 */
async function newPdfViaDialog(): Promise<NewPdfResult> {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow()
  if (!win) return { ok: false, error: 'No window available.' }
  const result = await showSaveDialogWithMemory(dialog, win, {
    defaultPath: 'Untitled.pdf',
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) return { ok: true, canceled: true }
  // Some platforms drop the extension the filter implies; the host only opens
  // .pdf, so add it rather than writing a file it cannot route.
  const target = PDF_RE.test(result.filePath) ? result.filePath : `${result.filePath}.pdf`
  try {
    await atomicWriteFile(target, await createBlankPdfBytes())
  } catch (err) {
    console.error('[desktop] new pdf write failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  await openDocumentPath(target)
  return { ok: true, path: target }
}

function showAboutDialog(): void {
  if (process.platform === 'darwin') {
    app.showAboutPanel()
    return
  }
  const win = mainWindow ?? BrowserWindow.getFocusedWindow()
  const options = {
    type: 'info' as const,
    title: 'About ARAReader',
    message: `ARAReader ${app.getVersion()}`,
    detail: `GPL-3.0-or-later\n${REPO_URL}\n\nSmart PDF reader and editor.`,
    buttons: ['OK', 'Open GitHub'],
    defaultId: 0,
    cancelId: 0,
  }
  void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then(
    (result) => {
      if (result.response === 1) void shell.openExternal(REPO_URL)
    },
  )
}

function sendPdfMenuCommand(command: PdfMenuCommand): void {
  const contents = tabManager?.activePdfWebContents()
  if (!contents || contents.isDestroyed()) return
  contents.send(PDF_CHANNELS.menuCommand, command)
}

function installMenu(): void {
  const labels = appMenuLabels(currentLang())
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void openPdfViaDialog() },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendPdfMenuCommand('save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendPdfMenuCommand('save-as'),
        },
        {
          label: 'Print…',
          accelerator: 'CmdOrCtrl+P',
          click: () => sendPdfMenuCommand('print'),
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => tabManager?.closeActiveTab(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    editMenuTemplate(process.platform, labels),
    viewMenuTemplate(labels),
    windowMenuTemplate(process.platform, labels),
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates…', click: () => checkForUpdates() },
        { type: 'separator' },
        { label: 'About ARAReader', click: () => showAboutDialog() },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 980,
    minHeight: 600,
    title: 'ARAReader',
    show: false,
    ...(existsSync(APP_ICON_PATH) ? { icon: APP_ICON_PATH } : {}),
    ...(process.platform === 'win32' ? { frame: false as const } : {}),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow = win
  const manager = new TabManager(win, () => {
    if (!win.isDestroyed()) win.webContents.send(TABS_CHANNELS.changed, manager.list())
  })
  tabManager = manager

  win.on('maximize', () => win.webContents.send(WINDOW_CHANNELS.stateChanged, true))
  win.on('unmaximize', () => win.webContents.send(WINDOW_CHANNELS.stateChanged, false))

  // Closing the whole window walks every dirty PDF tab through the same
  // save/don't-save/cancel prompt as closing it; any cancel aborts the close.
  let closeConfirmed = false
  win.on('close', (event) => {
    if (closeConfirmed) return
    const dirty = manager.dirtyPdfTabs()
    if (dirty.length === 0) return
    event.preventDefault()
    void (async () => {
      for (const tab of dirty) {
        manager.activateTab(tab.id)
        if (!(await requestPdfClose(tab.webContents, win))) {
          quitting = false
          return
        }
      }
      closeConfirmed = true
      // Quit cancelled by the guard resumes after the prompts; a plain window
      // close just closes the window (macOS keeps the app running).
      if (quitting) app.quit()
      else if (!win.isDestroyed()) win.close()
    })()
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    if (tabManager === manager) tabManager = null
  })

  // The navigation guard installs a default-deny window.open; links from the
  // home screen are user-activated, so route the safe ones to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = safeExternalUrl(url)
    if (safeUrl) void shell.openExternal(safeUrl)
    return { action: 'deny' }
  })

  // Open filling the screen on launch. `show:false` avoids a windowed flash
  // before the maximize lands; true fullscreen remains View > Toggle Full Screen.
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.maximize()
    win.show()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function revealWindow(): void {
  if (!mainWindow) createWindow()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
}

// ---- IPC ----

function stringPaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((path): path is string => typeof path === 'string')
    : []
}

function registerHomeIpc(): void {
  ipcMain.handle(HOME_CHANNELS.recents, async (_event: IpcMainInvokeEvent, query: unknown) =>
    readRecentPage(RECENT_FILE(), query),
  )
  ipcMain.handle(HOME_CHANNELS.openPath, async (_event: IpcMainInvokeEvent, path: unknown) => {
    if (typeof path === 'string') await openDocumentPath(path)
  })
  ipcMain.handle(HOME_CHANNELS.openPdf, () => openPdfViaDialog())
  ipcMain.handle(HOME_CHANNELS.newPdf, () => newPdfViaDialog())
  ipcMain.handle(HOME_CHANNELS.browse, () => openPdfViaDialog())
  ipcMain.handle(HOME_CHANNELS.removeRecent, async (_event: IpcMainInvokeEvent, paths: unknown) => {
    await removeRecentFiles(RECENT_FILE(), stringPaths(paths))
  })
  ipcMain.handle(HOME_CHANNELS.revealPath, async (_event: IpcMainInvokeEvent, path: unknown) => {
    if (typeof path === 'string' && (await pathExists(path))) shell.showItemInFolder(path)
  })
  ipcMain.handle(HOME_CHANNELS.getLanguage, () => currentLang())
  ipcMain.handle(HOME_CHANNELS.setLanguage, (_event: IpcMainInvokeEvent, lang: unknown) => {
    if (!isLang(lang) || lang === currentLang()) return
    persistLang(lang)
    installMenu()
    broadcast(PDF_CHANNELS.languageChanged, lang)
  })
  ipcMain.handle(HOME_CHANNELS.getTheme, () => currentTheme())
  ipcMain.handle(HOME_CHANNELS.setTheme, async (_event: IpcMainInvokeEvent, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return
    if (theme === currentTheme()) return
    cachedTheme = theme
    nativeTheme.themeSource = theme
    await writeAppSetting(APP_SETTINGS_PATH(), 'theme', theme)
  })
  ipcMain.handle(HOME_CHANNELS.getPreferences, () => readPreferences())
  ipcMain.handle(HOME_CHANNELS.setPreferences, (_event: IpcMainInvokeEvent, prefs: unknown) =>
    writePreferences(prefs),
  )
  ipcMain.handle(HOME_CHANNELS.getAppVersion, () => app.getVersion())
  ipcMain.handle(HOME_CHANNELS.getUpdateState, () => getAppUpdateState())
  ipcMain.handle(HOME_CHANNELS.checkForUpdates, () => checkForUpdates())
  ipcMain.handle(HOME_CHANNELS.restartAndInstall, () => restartAndInstall())
  ipcMain.handle(HOME_CHANNELS.getChangelog, () => fetchChangelog())
  ipcMain.handle(HOME_CHANNELS.getJustUpdated, () => getJustUpdated())
  ipcMain.handle(HOME_CHANNELS.clearJustUpdated, () => clearJustUpdated())
}

function registerTabsIpc(): void {
  ipcMain.handle(TABS_CHANNELS.list, () => tabManager?.list() ?? [])
  ipcMain.handle(TABS_CHANNELS.activate, (_event: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id === 'string') tabManager?.activateTab(id)
  })
  ipcMain.handle(TABS_CHANNELS.close, async (_event: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id === 'string') await tabManager?.closeTab(id)
  })
  ipcMain.handle(
    TABS_CHANNELS.reorder,
    (_event: IpcMainInvokeEvent, id: unknown, toIndex: unknown) => {
      if (typeof id === 'string' && Number.isInteger(toIndex)) {
        tabManager?.reorder(id, toIndex as number)
      }
    },
  )
}

function registerWindowIpc(): void {
  const targetWindow = (event: IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender) ?? mainWindow
  const broadcastWindowState = (win: BrowserWindow): void => {
    if (!win.isDestroyed()) win.webContents.send(WINDOW_CHANNELS.stateChanged, win.isMaximized())
  }
  ipcMain.handle(WINDOW_CHANNELS.minimize, (event: IpcMainInvokeEvent) =>
    targetWindow(event)?.minimize(),
  )
  ipcMain.handle(WINDOW_CHANNELS.toggleMaximize, (event: IpcMainInvokeEvent) => {
    const win = targetWindow(event)
    if (!win) return
    if (win.isMaximized()) win.restore()
    else win.maximize()
    broadcastWindowState(win)
  })
  ipcMain.handle(
    WINDOW_CHANNELS.isMaximized,
    (event: IpcMainInvokeEvent) => targetWindow(event)?.isMaximized() ?? false,
  )
  ipcMain.handle(WINDOW_CHANNELS.close, (event: IpcMainInvokeEvent) => targetWindow(event)?.close())
  ipcMain.handle(WINDOW_CHANNELS.openExternal, (_event: IpcMainInvokeEvent, url: unknown) => {
    const safeUrl = safeExternalUrl(url)
    if (safeUrl) void shell.openExternal(safeUrl)
  })
}

// ---- lifecycle ----

let pendingLaunchPath = pdfFileIn(process.argv)
/** a quit is in flight; the window's dirty-tab guard resumes it once prompts clear */
let quitting = false

app.on('before-quit', () => {
  quitting = true
})

function cleanArgPath(arg: string): string {
  return arg ? arg.replace(/^["']|["']$/g, '').trim() : ''
}

function pdfFileIn(argv: string[]): string | null {
  for (const raw of argv) {
    const arg = cleanArgPath(raw)
    if (arg && PDF_RE.test(arg) && existsSync(arg)) return arg
  }
  return null
}

// On macOS a file opened from Finder is not in argv; it arrives via open-file
// (possibly before ready). If another instance holds the lock, this process
// exits and the path must ride along in the lock request's additionalData, so
// the lock is requested at ready, once the path is known.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (!app.isReady()) {
    pendingLaunchPath = filePath
    return
  }
  revealWindow()
  void openDocumentPath(filePath).then((opened) => {
    if (!opened) tabManager?.openHomeTab()
  })
})

app.on('second-instance', (_event, argv, _cwd, additionalData) => {
  revealWindow()
  const launchPath = (additionalData as { launchPath?: string } | null)?.launchPath
  const file = pdfFileIn(argv) ?? (typeof launchPath === 'string' ? launchPath : null)
  void (async () => {
    if (!file || !(await openDocumentPath(file))) tabManager?.openHomeTab()
  })()
})

installNavigationGuard(app)
installContextMenu(app, () => contextMenuLabels(currentLang()))
registerHomeIpc()
registerTabsIpc()
registerWindowIpc()
// AI settings, streaming, attachments, and per-document history are host-wide:
// one registration serves the home screen and every PDF view.
registerAiBridge({
  getHostWindow: () => mainWindow,
  // A PDF view's unconfigured card: bring Home forward and let it open the
  // provider dialog (the host renderer owns the only provider UI).
  onConfigure: () => {
    tabManager?.openHomeTab()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(AI_CHANNELS.configureRequest)
    }
  },
})

// Keep WebContentsView chrome painting when another window overlaps it or the
// window is briefly occluded (Chromium otherwise discards the swapchain).
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-direct-composition')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

void app.whenReady().then(async () => {
  const hasLock = app.requestSingleInstanceLock(
    pendingLaunchPath ? { launchPath: pendingLaunchPath } : {},
  )
  if (!hasLock) {
    app.quit()
    return
  }

  // Startup identity banner: once per launch, main process only. A GUI launch from
  // Explorer has no attached console; terminal and dev runs show it.
  console.log(`ARAReader ${app.getVersion()} by Adhi Rahmadian - ${REPO_URL}`)

  if (process.platform === 'win32') app.setAppUserModelId('com.arareader.app')

  await primeUiSettings()
  currentLang()
  nativeTheme.themeSource = currentTheme()
  app.setAboutPanelOptions({
    applicationName: 'ARAReader',
    applicationVersion: app.getVersion(),
    copyright: 'GPL-3.0-or-later',
  })
  if (process.platform === 'darwin' && app.dock && existsSync(APP_ICON_PATH)) {
    app.dock.setIcon(APP_ICON_PATH)
  }

  // A Save As lands the PDF on a new path: re-title its tab, record the file,
  // and move the per-document transcript along with it.
  setPdfFileSavedHook((contents, filePath) => {
    const previous = tabManager?.filePathForWebContents(contents.id)
    tabManager?.setTabFileFor(contents.id, filePath)
    recordRecent(filePath)
    if (previous && previous !== filePath) projectFileRenamed(previous, filePath)
  })
  setPdfOpenPathHandler((filePath) => {
    void openDocumentPath(filePath)
  })

  createWindow()
  installMenu()
  // Auto-update: bumps lastSeenAppVersion, then checks 5s after launch and
  // every 4h (packaged Windows/macOS); a manual Help > Check for Updates…
  // runs the same path at any time.
  void initAutoUpdater(() => mainWindow)

  const launchPath = pendingLaunchPath
  pendingLaunchPath = null
  if (!launchPath || !(await openDocumentPath(launchPath))) tabManager?.openHomeTab()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
