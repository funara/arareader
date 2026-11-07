/// AI bridge for the desktop main process: the single owner of every `ai:*`
/// channel, the shared attachment (`files:*`) handlers, and the four
/// per-document history (`project:*`) handlers. Ported from ARAOffice's
/// docs-main `registerAiIpc`, attachment helpers, `files:*` handlers, and the
/// project resolve/append/load/rebind subset.
///
/// Why main and not the PDF view: provider credentials never cross into a
/// renderer. The stored settings file is the single source of truth for the
/// stream handlers (renderers only ever see redacted settings), and dialogs
/// need a real window parent.
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, webContents } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import {
  AiTimeoutError,
  activeProviderConfig,
  chatForProvider,
  defaultAiSettings,
  fetchCustomModels,
  mergeAiSettings,
  redactAiSettings,
  resolveAiSettings,
  streamForProvider,
} from '@arareader/ai-provider'
import type {
  AiChatRequest,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
} from '@arareader/ai-provider'
import { webExtract, webSearch } from '@arareader/ai-search'
import { atomicWriteFile, showOpenDialogWithMemory } from '@arareader/electron-utils'
import { parseFileToText } from '@arareader/file-parse'
import { ProjectStore, parseAppendChatArgs } from '@arareader/project-store'
import type {
  LoadChatArgs,
  RebindChatArgs,
  ResolveChatArgs,
  StartNewChatArgs,
} from '@arareader/project-store'
import {
  AI_CHANNELS,
  ATTACHMENT_IMAGE_EXTS,
  FILES_CHANNELS,
  PROJECT_CHANNELS,
} from '../shared/ai-api'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  FetchModelsResult,
} from '../shared/ai-api'

export interface AiBridgeOptions {
  /** the host BrowserWindow, used as the dialog parent for attachment pickers */
  getHostWindow?: () => BrowserWindow | null
  /** `ai:configure`: show the host's provider dialog (Home tab + configure request) */
  onConfigure?: () => void
}

// ---- limits ----

/** total attachment cap (text extraction reads the whole file) */
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
/** multimodal cap per image attachment: keeps the context from blowing up */
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** largest text slice returned by one `files:read` call */
const ATTACHMENT_TEXT_CHUNK_MAX = 24_000

/** plain-text extensions read as UTF-8 */
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'go',
  'rs',
  'rb',
  'sh',
  'sql',
  'css',
])

/** office/pdf formats get text extracted via @arareader/file-parse; images skip extraction and go multimodal */
const ATTACHMENT_EXTS = new Set([
  ...TEXT_EXTS,
  'docx',
  'pdf',
  'pptx',
  'ppt',
  'xlsx',
  'xls',
  ...ATTACHMENT_IMAGE_EXTS,
])

const ATTACHMENT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

// ---- settings (lazy: app.getPath is only valid after ready) ----

const settingsPath = (): string => join(app.getPath('userData'), 'ai-settings.json')

async function readStoredSettings(): Promise<Partial<AiSettings>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(), 'utf-8'))
    // a corrupted file may parse to null/array: treat anything but an object as empty
    return parsed && typeof parsed === 'object' ? (parsed as Partial<AiSettings>) : {}
  } catch {
    // missing or corrupted state file: fall back to defaults
    return {}
  }
}

async function writeStoredSettings(settings: AiSettings): Promise<void> {
  const filePath = settingsPath()
  await mkdir(dirname(filePath), { recursive: true })
  await atomicWriteFile(filePath, Buffer.from(JSON.stringify(settings, null, 2)))
}

// ---- per-WebContents attachment grants ----
// A renderer may only read files the user picked/dropped/pasted in that view:
// the model can ask `read_attachment` for any path, so the grant list (not the
// request) is the authority.

const grantedAttachments = new Map<number, Set<string>>()
const trackedGrantHolders = new Set<number>()

function grantAttachments(sender: WebContents, paths: string[]): void {
  if (paths.length === 0) return
  const set = grantedAttachments.get(sender.id) ?? new Set<string>()
  for (const path of paths) set.add(path)
  grantedAttachments.set(sender.id, set)
  if (trackedGrantHolders.has(sender.id) || sender.isDestroyed()) return
  trackedGrantHolders.add(sender.id)
  // teardown: a crashed/closed view must not leave grants reachable
  sender.once('destroyed', () => {
    trackedGrantHolders.delete(sender.id)
    grantedAttachments.delete(sender.id)
  })
}

function hasAttachmentGrant(wcId: number, filePath: string): boolean {
  return grantedAttachments.get(wcId)?.has(filePath) === true
}

// ---- attachment helpers ----

/** extracted text cache keyed by path; invalidated by mtime+size */
const attachmentTextCache = new Map<string, { stamp: string; text: string }>()

async function statAttachment(
  filePath: string,
): Promise<{ meta?: AttachmentMeta; error?: string }> {
  const name = basename(filePath)
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (!ATTACHMENT_EXTS.has(ext)) {
    return { error: `${name}: unsupported file type${ext ? ` .${ext}` : ''}` }
  }
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return { error: `${name}: not a file` }
    if (info.size > ATTACHMENT_MAX_BYTES) return { error: `${name}: larger than 20 MB` }
    if (ATTACHMENT_IMAGE_EXTS.has(ext) && info.size > ATTACHMENT_IMAGE_MAX_BYTES) {
      return { error: `${name}: image larger than 5 MB` }
    }
    return { meta: { path: filePath, name, ext, sizeBytes: info.size } }
  } catch {
    return { error: `${name}: unreadable` }
  }
}

async function collectAttachments(paths: string[]): Promise<AttachmentAddResult> {
  const accepted: AttachmentMeta[] = []
  const rejected: string[] = []
  for (const path of paths) {
    const { meta, error } = await statAttachment(path)
    if (meta) accepted.push(meta)
    else if (error) rejected.push(error)
  }
  return { accepted, rejected }
}

/**
 * Parse an attachment to text. `file-parse` handles office/pdf/plain text;
 * source-code extensions are accepted as attachments too, so they fall back to
 * a plain UTF-8 read instead of failing the whole read.
 */
async function extractAttachmentText(filePath: string): Promise<string> {
  const info = await stat(filePath)
  const stamp = `${info.mtimeMs}:${info.size}`
  const cached = attachmentTextCache.get(filePath)
  if (cached && cached.stamp === stamp) return cached.text
  if (info.size > ATTACHMENT_MAX_BYTES) throw new Error('File is larger than 20 MB')
  const ext = basename(filePath).split('.').pop()?.toLowerCase() ?? ''
  const parsed = await parseFileToText(filePath)
  let text: string
  if (parsed.ok && parsed.kind === 'text' && parsed.text != null) {
    text = parsed.text
  } else if (TEXT_EXTS.has(ext)) {
    text = await readFile(filePath, 'utf-8')
  } else {
    throw new Error(parsed.error ?? 'Unable to read this file as text')
  }
  attachmentTextCache.set(filePath, { stamp, text })
  // keep the cache bounded (a handful of recent files is plenty)
  if (attachmentTextCache.size > 8) {
    const oldest = attachmentTextCache.keys().next().value
    if (oldest) attachmentTextCache.delete(oldest)
  }
  return text
}

// clipboard-pasted images (screenshots/bitmaps with no local path) are saved to
// a temp file and then take the regular attachment path
let pastedImageSeq = 0
let pastedDirPruned = false

/** drop pasted-image temp files older than 7 days (once per app run) */
async function prunePastedImages(dir: string): Promise<void> {
  if (pastedDirPruned) return
  pastedDirPruned = true
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  try {
    for (const name of await readdir(dir)) {
      const path = join(dir, name)
      try {
        if ((await stat(path)).mtimeMs < cutoff) await unlink(path)
      } catch {
        // ignore: another tab may have removed it already
      }
    }
  } catch {
    // ignore: directory may not exist yet
  }
}

/** save pasted image bytes to `<temp>/arareader-pasted`; an error message for non-images or oversized data */
async function savePastedImage(
  data: unknown,
  ext: unknown,
): Promise<{ path: string } | { error: string }> {
  const cleanExt = typeof ext === 'string' ? ext.toLowerCase() : ''
  if (!ATTACHMENT_IMAGE_EXTS.has(cleanExt)) {
    return { error: 'Clipboard data is not a supported image' }
  }
  const bytes =
    data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null
  if (!bytes || bytes.byteLength === 0) return { error: 'Clipboard image is empty' }
  if (bytes.byteLength > ATTACHMENT_IMAGE_MAX_BYTES) {
    return { error: 'Clipboard image is larger than 5 MB' }
  }
  const dir = join(app.getPath('temp'), 'arareader-pasted')
  await mkdir(dir, { recursive: true })
  await prunePastedImages(dir)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const filePath = join(dir, `pasted-${stamp}-${++pastedImageSeq}.${cleanExt}`)
  await writeFile(filePath, bytes)
  return { path: filePath }
}

// ---- streams ----

const activeAiStreams = new Map<string, AbortController>()

function cancelStream(requestId: string): void {
  const controller = activeAiStreams.get(requestId)
  if (!controller) return
  controller.abort()
  activeAiStreams.delete(requestId)
}

// ---- project store (one per app, lazy: app.getPath is only valid after ready) ----

let projectStore: ProjectStore | null = null

function getProjectStore(): ProjectStore {
  if (!projectStore) projectStore = new ProjectStore(app.getPath('userData'))
  return projectStore
}

/**
 * After a file is renamed/moved on disk, sync project-store so fileMap and
 * chatIdByPath re-key and the transcript follows the file (Save As hook).
 * Best-effort: a history bookkeeping failure must never break a save.
 */
export function projectFileRenamed(oldPath: string, newPath: string): void {
  if (typeof oldPath !== 'string' || typeof newPath !== 'string') return
  if (!oldPath || !newPath || oldPath === newPath) return
  try {
    getProjectStore().fileRenamed(oldPath, newPath)
  } catch (err) {
    console.warn('[ai-bridge] project fileRenamed failed:', err)
  }
}

// ---- IPC ----

let registered = false
let bridgeOptions: AiBridgeOptions = {}

function dialogParent(event: IpcMainInvokeEvent): BrowserWindow | null {
  const host = bridgeOptions.getHostWindow?.()
  if (host && !host.isDestroyed()) return host
  return BrowserWindow.fromWebContents(event.sender)
}

/**
 * Register every AI/files/project handler once. Safe to call before
 * `app.whenReady()`: nothing here touches `app.getPath` until a request arrives.
 */
export function registerAiBridge(options: AiBridgeOptions = {}): void {
  if (registered) return
  registered = true
  bridgeOptions = options

  // ── settings ─────────────────────────────────────────────

  ipcMain.handle(AI_CHANNELS.getSettings, async (): Promise<AiSettings> => {
    const stored = await readStoredSettings()
    return redactAiSettings(resolveAiSettings(stored, defaultAiSettings()))
  })

  ipcMain.handle(AI_CHANNELS.setSettings, async (_event, settings: AiSettings) => {
    const stored = await readStoredSettings()
    // The renderer only ever sees redacted settings, so an untouched key arrives
    // as ''. mergeAiSettings keeps the stored key per provider in that case.
    const normalized = mergeAiSettings(
      resolveAiSettings(stored, defaultAiSettings()),
      (settings ?? {}) as Partial<AiSettings>,
    )
    await writeStoredSettings(normalized)
    const redacted = redactAiSettings(normalized)
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue
      try {
        contents.send(AI_CHANNELS.settingsChanged, redacted)
      } catch {
        /* frame disposed */
      }
    }
  })

  ipcMain.handle(AI_CHANNELS.configure, () => {
    bridgeOptions.onConfigure?.()
    return { ok: true }
  })

  ipcMain.handle(
    AI_CHANNELS.fetchCustomModels,
    async (
      _event,
      override?: { baseUrl?: string; apiKey?: string },
    ): Promise<FetchModelsResult> => {
      const stored = await readStoredSettings()
      const settings = resolveAiSettings(stored, defaultAiSettings())
      const custom = settings.providers.custom
      // A fresh (unsaved) key from the dialog is used for this probe only and
      // never leaves the main process.
      const baseUrl = override?.baseUrl?.trim() || custom.baseUrl
      const apiKey = override?.apiKey?.trim() || custom.apiKey
      if (!baseUrl) return { ok: true, models: [] }
      try {
        const models = await fetchCustomModels({ model: custom.model, baseUrl, apiKey })
        return { ok: true, models }
      } catch (err) {
        return {
          ok: false,
          models: [],
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  )

  // ── streaming ────────────────────────────────────────────

  const handleCancelStream = (_event: IpcMainInvokeEvent, requestId: unknown) => {
    if (typeof requestId === 'string') cancelStream(requestId)
    return { ok: true }
  }
  ipcMain.handle(AI_CHANNELS.cancel, handleCancelStream)
  ipcMain.handle(AI_CHANNELS.streamCancel, handleCancelStream)

  ipcMain.handle(AI_CHANNELS.stream, async (event, request: AiStreamRequest) => {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : ''
    if (!requestId) return
    // The PDF dock is the only stream client; request.app is carried for
    // diagnostics and defaults when a caller omits it.
    const streamApp: AiStreamRequest['app'] = request.app ?? 'pdf'
    const system = typeof request.system === 'string' ? request.system : ''
    const messages = request.messages ?? []
    const tools = request.tools ?? []
    const maxTokens = request.maxTokens ?? 8192
    // The renderer holds redacted settings only (no apiKey), so the stored copy
    // is the single source of truth for provider + credentials.
    const normalized = resolveAiSettings(await readStoredSettings(), defaultAiSettings())
    const { provider, config } = activeProviderConfig(normalized)
    // A crashed renderer's WebContents is not yet destroyed but its frame is
    // gone: send() throws "Render frame was disposed". Treat any send failure
    // as end of stream so the provider request aborts instead of erroring on
    // every pending flush until the run finishes.
    let senderDead = false
    const send = (chunk: AiStreamChunk): boolean => {
      if (senderDead) return false
      try {
        if (event.sender.isDestroyed() || event.sender.isCrashed()) {
          senderDead = true
          return false
        }
        event.sender.send(AI_CHANNELS.streamChunk, chunk)
        return true
      } catch {
        senderDead = true
        return false
      }
    }
    if (!config.model) {
      send({ requestId, type: 'error', error: 'No model configured.' })
      return
    }
    const controller = new AbortController()
    activeAiStreams.set(requestId, controller)
    // wire-activity keepalive: lets the renderer's silence watchdog tell a slow
    // turn from a dead one
    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < 5_000) return
      lastPing = now
      send({ requestId, type: 'ping' })
    }
    // Coalesce per-token deltas/thinking into ~120 ms batches. One IPC message
    // per token makes the renderer re-render its whole chat on each token,
    // which on long runs saturates the renderer (UI freeze, then a crash).
    let pendingDelta = ''
    let pendingThinking = ''
    let flushTimer: NodeJS.Timeout | undefined
    const flushPending = () => {
      clearTimeout(flushTimer)
      flushTimer = undefined
      if (pendingThinking) {
        if (!send({ requestId, type: 'thinking', text: pendingThinking })) {
          controller.abort()
          return
        }
        pendingThinking = ''
      }
      if (pendingDelta) {
        if (!send({ requestId, type: 'delta', text: pendingDelta })) {
          controller.abort()
          return
        }
        pendingDelta = ''
      }
    }
    const armFlush = () => {
      // deltas feed the streaming reply and stay snappy; thinking-only batches
      // feed a slow-scrolling preview, so long thinking stretches get a gentler
      // cadence
      flushTimer ??= setTimeout(flushPending, pendingDelta ? 120 : 400)
    }
    try {
      let stopReason: string | undefined
      await streamForProvider(provider, config, system, messages, tools, maxTokens, {
        signal: controller.signal,
        onDelta: (text) => {
          pendingDelta += text
          armFlush()
        },
        onThinking: (text) => {
          pendingThinking += text
          armFlush()
        },
        onToolCall: (toolCall) => {
          flushPending()
          if (!send({ requestId, type: 'tool-call', toolCall })) controller.abort()
        },
        onActivity: ping,
        onStopReason: (reason) => {
          stopReason = reason
        },
      })
      flushPending()
      send({ requestId, type: 'done', stopReason })
    } catch (err) {
      flushPending()
      if (controller.signal.aborted) {
        // user cancel: a cancel is a normal end, not an error
        send({ requestId, type: 'done' })
      } else {
        console.warn(`[ai-bridge] ${streamApp} stream failed:`, err)
        send({
          requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof AiTimeoutError ? { errorCode: 'timeout' as const } : {}),
        })
      }
    } finally {
      clearTimeout(flushTimer)
      activeAiStreams.delete(requestId)
    }
  })

  ipcMain.handle(AI_CHANNELS.chat, async (_event, request: AiChatRequest) => {
    const system = typeof request?.system === 'string' ? request.system : ''
    const user = typeof request?.user === 'string' ? request.user : ''
    const normalized = resolveAiSettings(await readStoredSettings(), defaultAiSettings())
    const { provider, config } = activeProviderConfig(normalized)
    if (!config.model) return { ok: false, error: 'No model configured.' }
    try {
      return await chatForProvider(provider, config, system, user)
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ── web tools ────────────────────────────────────────────

  ipcMain.handle(AI_CHANNELS.webSearch, async (_event, query: unknown, maxResults?: unknown) => {
    try {
      return await webSearch(String(query ?? ''), typeof maxResults === 'number' ? maxResults : 6)
    } catch (err) {
      return { results: [], method: 'error', error: String(err) }
    }
  })

  ipcMain.handle(AI_CHANNELS.webFetch, async (_event, url: unknown) => {
    const input = String(url ?? '')
    try {
      // webExtract revalidates every redirect hop against the private/loopback
      // blocklist, so an unsafe target yields no content at all.
      const result = await webExtract(input, 24_000, 'full')
      // Blocked/private targets come back with no extractable content. Mark
      // that as an error so callers cannot mistake it for a valid empty page.
      const content = result.content ?? ''
      return {
        title: result.title ?? '',
        url: result.url,
        content,
        ...(content ? {} : { isError: true }),
      }
    } catch {
      return { title: '', url: input, content: '', isError: true }
    }
  })

  // ── attachments ──────────────────────────────────────────

  ipcMain.handle(FILES_CHANNELS.pick, async (event): Promise<AttachmentAddResult | null> => {
    const result = await showOpenDialogWithMemory(dialog, dialogParent(event), {
      title: 'Add attachment',
      filters: [
        { name: 'Supported files', extensions: [...ATTACHMENT_EXTS] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const collected = await collectAttachments(result.filePaths)
    grantAttachments(
      event.sender,
      collected.accepted.map((attachment) => attachment.path),
    )
    return collected
  })

  ipcMain.handle(
    FILES_CHANNELS.add,
    async (event, paths: unknown): Promise<AttachmentAddResult> => {
      const list = Array.isArray(paths)
        ? paths.filter((path): path is string => typeof path === 'string' && path !== '')
        : []
      const collected = await collectAttachments(list)
      grantAttachments(
        event.sender,
        collected.accepted.map((attachment) => attachment.path),
      )
      return collected
    },
  )

  ipcMain.handle(
    FILES_CHANNELS.read,
    async (
      event,
      filePath: unknown,
      offset: unknown,
      maxChars: unknown,
    ): Promise<AttachmentReadResult> => {
      const path = typeof filePath === 'string' ? filePath : ''
      const name = path ? basename(path) : ''
      if (!path || !hasAttachmentGrant(event.sender.id, path)) {
        return { ok: false, error: `${name || 'File'}: unreadable` }
      }
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      if (!ATTACHMENT_EXTS.has(ext)) {
        return { ok: false, error: `${name}: unsupported file type${ext ? ` .${ext}` : ''}` }
      }
      if (ATTACHMENT_IMAGE_EXTS.has(ext)) return { ok: false, error: `${name}: image has no text` }
      try {
        const text = await extractAttachmentText(path)
        const start = Math.max(0, Math.floor(Number(offset)) || 0)
        const size = Math.min(
          Math.max(1, Math.floor(Number(maxChars)) || 1),
          ATTACHMENT_TEXT_CHUNK_MAX,
        )
        return {
          ok: true,
          name,
          totalChars: text.length,
          offset: start,
          text: text.slice(start, start + size),
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    FILES_CHANNELS.readImage,
    async (event, filePath: unknown): Promise<AttachmentImageResult> => {
      const path = typeof filePath === 'string' ? filePath : ''
      const name = path ? basename(path) : ''
      if (!path || !hasAttachmentGrant(event.sender.id, path)) {
        return { ok: false, error: `${name || 'File'}: unreadable` }
      }
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      const mime = ATTACHMENT_IMAGE_MIME[ext]
      if (!mime) return { ok: false, error: `${name}: not an image` }
      try {
        const info = await stat(path)
        if (info.size > ATTACHMENT_IMAGE_MAX_BYTES) {
          return { ok: false, error: `${name}: image larger than 5 MB` }
        }
        return { ok: true, base64: (await readFile(path)).toString('base64'), mime }
      } catch {
        return { ok: false, error: `${name}: unreadable` }
      }
    },
  )

  ipcMain.handle(
    FILES_CHANNELS.addPastedImage,
    async (event, data: unknown, ext: unknown): Promise<AttachmentAddResult> => {
      const saved = await savePastedImage(data, ext)
      if ('error' in saved) return { accepted: [], rejected: [saved.error] }
      const collected = await collectAttachments([saved.path])
      grantAttachments(
        event.sender,
        collected.accepted.map((attachment) => attachment.path),
      )
      return collected
    },
  )

  // ── per-document chat history ────────────────────────────

  ipcMain.handle(PROJECT_CHANNELS.resolveChat, (_event, args: ResolveChatArgs) => {
    const filePath = typeof args?.filePath === 'string' && args.filePath ? args.filePath : null
    const tempChatId =
      typeof args?.tempChatId === 'string' && args.tempChatId ? args.tempChatId : undefined
    const store = getProjectStore()
    store.ensureDefaultProject()
    if (!filePath) {
      const chatId = tempChatId ?? `unsaved-${Date.now()}`
      return { projectId: 'default', chatId, boundarySeq: store.chatBoundary(chatId) }
    }
    return store.resolveChatForFile(filePath)
  })

  ipcMain.handle(PROJECT_CHANNELS.appendChat, (_event, args: unknown) => {
    const parsed = parseAppendChatArgs(args)
    if (!parsed) return false
    try {
      return getProjectStore().appendChatMessage(parsed.projectId, parsed.chatId, parsed.message)
    } catch {
      return false
    }
  })

  // Durable conversation boundary: earlier messages stay on disk, later ones
  // belong to the new conversation. Nothing is deleted on New chat.
  ipcMain.handle(PROJECT_CHANNELS.startNewChat, (_event, args: StartNewChatArgs) => {
    const projectId =
      typeof args?.projectId === 'string' && args.projectId ? args.projectId : 'default'
    const chatId = typeof args?.chatId === 'string' ? args.chatId : ''
    if (!chatId) return { projectId, chatId, boundarySeq: 0 }
    // A rejected write must reach the renderer: the panel shows a retryable banner
    // instead of silently losing the New-chat boundary.
    return { projectId, chatId, boundarySeq: getProjectStore().startNewChat(projectId, chatId) }
  })

  ipcMain.handle(PROJECT_CHANNELS.loadChat, (_event, args: LoadChatArgs) => {
    if (!args || typeof args.projectId !== 'string' || typeof args.chatId !== 'string') return []
    const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 200
    // A read failure rejects instead of returning []: an empty list would tell the
    // panel the conversation was empty and silently lose the earlier messages.
    return getProjectStore().loadChat(args.projectId, args.chatId, limit)
  })

  ipcMain.handle(PROJECT_CHANNELS.rebindChat, (_event, args: RebindChatArgs) => {
    const projectId = typeof args?.projectId === 'string' ? args.projectId : 'default'
    const tempChatId = typeof args?.tempChatId === 'string' ? args.tempChatId : ''
    const store = getProjectStore()
    try {
      // first save / Save As: the chat id is derived from the real path and the
      // temp transcript moves along with it
      if (typeof args?.newFilePath === 'string' && args.newFilePath) {
        return store.rebindChatToFile(projectId, tempChatId, args.newFilePath)
      }
      if (typeof args?.newChatId === 'string' && args.newChatId) {
        store.rebindChat(projectId, tempChatId, args.newChatId)
      }
      const chatId = args?.newChatId ?? tempChatId
      return { projectId, chatId, boundarySeq: store.chatBoundary(chatId) }
    } catch (err) {
      console.warn('[ai-bridge] project rebindChat failed:', err)
      // No boundarySeq: the caller must treat the boundary as unknown, not as
      // "never cut" (0 would re-seed the closed conversation into the model)
      return { projectId, chatId: args?.newChatId ?? tempChatId }
    }
  })
}
