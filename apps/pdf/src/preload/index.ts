import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Lang } from '@arareader/i18n'
import type { AiSettings, AiStreamChunk } from '@arareader/ai-provider'
import { AI_CHANNELS, FILES_CHANNELS, PDF_CHANNELS, PROJECT_CHANNELS } from '../shared/ipc'
import type { PdfApi, PdfMenuCommand, PdfProjectApi, SharedUserPreferences } from '../shared/ipc'

const api: PdfApi = {
  consumePending: () => ipcRenderer.invoke(PDF_CHANNELS.consumePending),
  readFile: (path) => ipcRenderer.invoke(PDF_CHANNELS.readFile, path),
  save: (request) => ipcRenderer.invoke(PDF_CHANNELS.save, request),
  onMenuCommand: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, command: PdfMenuCommand) => handler(command)
    ipcRenderer.on(PDF_CHANNELS.menuCommand, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.menuCommand, listener)
  },
  onFileChanged: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, path: string) => handler(path)
    ipcRenderer.on(PDF_CHANNELS.fileChanged, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.fileChanged, listener)
  },
  pickSavePath: (suggestedName) => ipcRenderer.invoke(PDF_CHANNELS.pickSavePath, suggestedName),
  extractPages: (request) => ipcRenderer.invoke(PDF_CHANNELS.extractPages, request),
  insertPdf: (request) => ipcRenderer.invoke(PDF_CHANNELS.insertPdf, request),
  insertBlankPage: (request) => ipcRenderer.invoke(PDF_CHANNELS.insertBlankPage, request),
  duplicatePages: (request) => ipcRenderer.invoke(PDF_CHANNELS.duplicatePages, request),
  exportImages: (request) => ipcRenderer.invoke(PDF_CHANNELS.exportImages, request),
  exportText: (request) => ipcRenderer.invoke(PDF_CHANNELS.exportText, request),
  exportEmbeddedImages: (request) => ipcRenderer.invoke(PDF_CHANNELS.exportEmbeddedImages, request),
  setOutline: (request) => ipcRenderer.invoke(PDF_CHANNELS.setOutline, request),
  splitPdf: (request) => ipcRenderer.invoke(PDF_CHANNELS.splitPdf, request),
  combinePdfs: (request) => ipcRenderer.invoke(PDF_CHANNELS.combinePdfs, request),
  sanitizePdf: (request) => ipcRenderer.invoke(PDF_CHANNELS.sanitizePdf, request),
  sanitizePreview: (request) => ipcRenderer.invoke(PDF_CHANNELS.sanitizePreview, request),
  deleteAnnotations: (request) => ipcRenderer.invoke(PDF_CHANNELS.deleteAnnotations, request),
  a11yCheck: (request) => ipcRenderer.invoke(PDF_CHANNELS.a11yCheck, request),
  a11yFix: (request) => ipcRenderer.invoke(PDF_CHANNELS.a11yFix, request),
  setDirty: (dirty) => ipcRenderer.send(PDF_CHANNELS.dirtyChanged, dirty),
  onCloseSaveRequest: (handler) => {
    const listener = () => handler()
    ipcRenderer.on(PDF_CHANNELS.closeSaveRequest, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.closeSaveRequest, listener)
  },
  sendCloseSaveResult: (ok) => ipcRenderer.send(PDF_CHANNELS.closeSaveResult, ok),
  getLanguage: () => ipcRenderer.invoke(PDF_CHANNELS.getLanguage),
  onLanguageChanged: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, lang: Lang) => handler(lang)
    ipcRenderer.on(PDF_CHANNELS.languageChanged, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.languageChanged, listener)
  },
  getPreferences: () => ipcRenderer.invoke(PDF_CHANNELS.getPreferences),
  setPreferences: (prefs) => ipcRenderer.invoke(PDF_CHANNELS.setPreferences, prefs),
  onPreferencesChanged: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, prefs: SharedUserPreferences) => handler(prefs)
    ipcRenderer.on(PDF_CHANNELS.preferencesChanged, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.preferencesChanged, listener)
  },
  getAiSettings: () => ipcRenderer.invoke(AI_CHANNELS.getSettings),
  configureAi: () => ipcRenderer.invoke(AI_CHANNELS.configure),
  onAiSettingsChanged: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, s: AiSettings) => handler(s)
    ipcRenderer.on(AI_CHANNELS.settingsChanged, listener)
    return () => ipcRenderer.removeListener(AI_CHANNELS.settingsChanged, listener)
  },
  aiStream: (request) => ipcRenderer.invoke(AI_CHANNELS.stream, request),
  aiStreamCancel: (requestId) => ipcRenderer.invoke(AI_CHANNELS.streamCancel, requestId),
  onAiStream: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, chunk: AiStreamChunk) => handler(chunk)
    ipcRenderer.on(AI_CHANNELS.streamChunk, listener)
    return () => ipcRenderer.removeListener(AI_CHANNELS.streamChunk, listener)
  },
  aiChat: (request) => ipcRenderer.invoke(AI_CHANNELS.chat, request),
  pickAttachments: () => ipcRenderer.invoke(FILES_CHANNELS.pick),
  addAttachmentPaths: (paths) => ipcRenderer.invoke(FILES_CHANNELS.add, paths),
  addPastedImage: (data, ext) => ipcRenderer.invoke(FILES_CHANNELS.addPastedImage, data, ext),
  readAttachment: (path, offset, maxChars) =>
    ipcRenderer.invoke(FILES_CHANNELS.read, path, offset, maxChars),
  readAttachmentImage: (path) => ipcRenderer.invoke(FILES_CHANNELS.readImage, path),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  webSearch: (query, maxResults) => ipcRenderer.invoke(AI_CHANNELS.webSearch, query, maxResults),
  webFetch: (url) => ipcRenderer.invoke(AI_CHANNELS.webFetch, url),
}

contextBridge.exposeInMainWorld('pdfApi', api)

/** Per-document chat history (project store, shared with the host's IPC handlers) */
const projectApi: PdfProjectApi = {
  resolveChat: (args) => ipcRenderer.invoke(PROJECT_CHANNELS.resolveChat, args),
  appendChat: (args) => ipcRenderer.invoke(PROJECT_CHANNELS.appendChat, args),
  loadChat: (args) => ipcRenderer.invoke(PROJECT_CHANNELS.loadChat, args),
  rebindChat: (args) => ipcRenderer.invoke(PROJECT_CHANNELS.rebindChat, args),
}

contextBridge.exposeInMainWorld('pdfProject', projectApi)

// OS file drops open a new host tab; page reorder drops carry no files and are ignored.
// The AI panel owns its own drops (attachments): anything dropped inside it must not
// open a tab, and neither must a drop some other handler already consumed.
const AI_DROP_SELECTORS = ['.ai-panel', '.ai-dock']

function droppedPdfPaths(event: DragEvent): string[] {
  const files = Array.from(event.dataTransfer?.files ?? [])
  return files
    .map((file) => webUtils.getPathForFile(file))
    .filter((path) => path !== '' && /\.pdf$/i.test(path))
}

/** true when the drop landed inside the AI panel/dock (attachments, not a new tab) */
function insideAiPanel(event: DragEvent): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  return AI_DROP_SELECTORS.some((selector) => target.closest(selector) !== null)
}

window.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
})
window.addEventListener('drop', (event) => {
  if (event.defaultPrevented || insideAiPanel(event)) return
  const paths = droppedPdfPaths(event)
  if (paths.length === 0) return
  event.preventDefault()
  for (const path of paths) ipcRenderer.send(PDF_CHANNELS.openInNewTab, path)
})
