import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@arareader/agent-core'
import type { ChatMessage } from '@arareader/project-store'
import { AiPanel } from '../src/renderer/ai/AiPanel'
import { LocaleProvider } from '../src/renderer/i18n/locale'
import type { PdfSkillDeps } from '../src/renderer/ai/tools'
import type { AttachmentMeta, PdfApi, PdfProjectApi } from '../src/shared/ipc'

/**
 * Panel orchestration under a mocked provider transport (window.pdfApi.aiStream)
 * and mocked history IPC (window.pdfProject). These are the claims that only the
 * real panel can break:
 *
 * - the ACTIVE conversation is restored after a reload; the earlier conversation
 *   is not
 * - a failed run after an applied edit is known to the same-session follow-up
 * - a retry re-grants and re-sends its attachment (or refuses to send)
 * - stale loads/startup cannot land in a new chat
 * - failed history writes retry once, in order
 */

interface Chunk {
  requestId: string
  type: 'delta' | 'done' | 'error' | 'tool-call'
  text?: string
  toolCall?: { id: string; name: string; input: Record<string, unknown> }
  error?: string
}

interface StreamRequest {
  requestId: string
  messages: AgentMessage[]
  system: string
}

interface StreamEmit {
  delta(text: string): void
  tool(call: { id: string; name: string; input: Record<string, unknown> }): void
  done(): void
  error(message: string): void
}

type StreamScript = (emit: StreamEmit) => void

interface AppendArgs {
  projectId: string
  chatId: string
  role: 'user' | 'assistant'
  text: string
  status?: string
  attachments?: Array<{ name: string; path?: string; ext?: string; sizeBytes?: number }>
  tools?: Array<Record<string, unknown>>
}

// React's act() needs this flag outside the react-dom/test-utils entry.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no layout/scrollTo; the panel only uses it for auto-follow
if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = () => {}
}

const READY_SETTINGS = {
  provider: 'google',
  providers: { google: { model: 'gemini-2.0-flash', hasApiKey: true } },
}

const IMAGE: AttachmentMeta = {
  path: '/tmp/pic.png',
  name: 'pic.png',
  ext: 'png',
  sizeBytes: 1024,
}

function message(partial: Partial<ChatMessage>): ChatMessage {
  return {
    seq: 0,
    ts: '2024-01-01T00:00:00.000Z',
    role: 'assistant',
    text: '',
    ...partial,
  }
}

/** All renderer-visible text of a provider request (the model context) */
function requestText(request: StreamRequest): string {
  return request.messages
    .map((entry) =>
      entry.role === 'tool' ? entry.results.map((r) => r.output).join('\n') : entry.text,
    )
    .join('\n\n')
}

function makeHarness(
  options: {
    history?: ChatMessage[]
    boundarySeq?: number
    resolveChat?: () => Promise<{ projectId: string; chatId: string; boundarySeq?: number }>
    loadChat?: () => Promise<ChatMessage[]>
  } = {},
) {
  const listeners = new Set<(chunk: Chunk) => void>()
  const requests: StreamRequest[] = []
  const scripts: StreamScript[] = []
  const appendCalls: AppendArgs[] = []
  const emit = (chunk: Chunk): void => {
    for (const listener of [...listeners]) listener(chunk)
  }

  const api = {
    getPreferences: vi.fn(async () => ({ aiAutoSuggestions: false })),
    aiChat: vi.fn(async () => ({ ok: true, content: '[]' })),
    getAiSettings: vi.fn<() => Promise<unknown>>(async () => READY_SETTINGS),
    onAiSettingsChanged: vi.fn(() => () => {}),
    onAiStream: vi.fn((handler: (chunk: Chunk) => void) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    }),
    aiStream: vi.fn(async (request: StreamRequest) => {
      requests.push(request)
      const script = scripts.shift()
      if (!script) return
      const requestId = request.requestId
      setTimeout(() => {
        script({
          delta: (text) => emit({ requestId, type: 'delta', text }),
          tool: (toolCall) => emit({ requestId, type: 'tool-call', toolCall }),
          done: () => emit({ requestId, type: 'done' }),
          error: (error) => emit({ requestId, type: 'error', error }),
        })
      }, 0)
    }),
    aiStreamCancel: vi.fn(async () => {}),
    getLanguage: vi.fn(async () => 'en' as const),
    onLanguageChanged: vi.fn(() => () => {}),
    pickAttachments: vi.fn<() => Promise<unknown>>(async () => null),
    addAttachmentPaths: vi.fn<() => Promise<unknown>>(async () => ({ accepted: [], rejected: [] })),
    addPastedImage: vi.fn(async () => ({ accepted: [], rejected: [] })),
    readAttachment: vi.fn(async () => ({ ok: false, error: 'not used' })),
    readAttachmentImage: vi.fn<() => Promise<unknown>>(async () => ({
      ok: true,
      base64: 'AAAA',
      mime: 'image/png',
    })),
    getPathForFile: vi.fn(() => ''),
    configureAi: vi.fn(async () => {}),
  }

  const project: PdfProjectApi = {
    resolveChat: vi.fn(
      options.resolveChat ??
        (async () => ({ projectId: 'p1', chatId: 'c1', boundarySeq: options.boundarySeq ?? 0 })),
    ),
    appendChat: vi.fn(async (args: AppendArgs) => {
      appendCalls.push(args)
      return true
    }),
    loadChat: vi.fn(async () => options.history ?? []),
    rebindChat: vi.fn(async () => ({
      projectId: 'p1',
      chatId: 'c1',
      boundarySeq: options.boundarySeq ?? 0,
    })),
    startNewChat: vi.fn(async () => ({ projectId: 'p1', chatId: 'c1', boundarySeq: 99 })),
  } as unknown as PdfProjectApi

  const deps = {
    doc: () => null,
    fileName: () => 'document.pdf',
    pageCount: () => 3,
    currentPage: () => 1,
    readOnly: () => false,
    outline: () => null,
    searchIndex: () => null,
    isDeleted: () => false,
    gotoPage: () => true,
    addMarkup: () => {},
    formEdits: () => new Map(),
    applyFormEdit: () => {},
    rotatePage: () => {},
    deletePage: vi.fn(() => true),
    pageGeom: () => ({ width: 612, height: 792, rotation: 0 }),
    applyContentEdit: () => {},
    addNote: () => {},
    setDocumentMetadata: () => {},
    writeOutline: async () => ({ ok: true as const }),
  }

  return { api, project, deps, requests, scripts, appendCalls }
}

type Harness = ReturnType<typeof makeHarness>

interface PendingCall {
  label: 'resolve' | 'rebind' | 'boundary'
  apply: () => unknown
  settle: (value: unknown) => void
}

/**
 * Small stand-in for project-store: a chat holds rows, the "index" holds one
 * chatId per path and one boundary per chatId, and rebinding moves both with the
 * transcript (like ProjectStore.renameOrMergeChat). `resolve`, `rebind` and
 * `startNewChat` stay pending until the test completes them, so two concurrent
 * IPC calls can be finished in either order.
 */
function makeFakeHistory(draftPath: string) {
  const chats = new Map<string, ChatMessage[]>()
  const boundaries = new Map<string, number>()
  const paths = new Map<string, string>()
  const pending: PendingCall[] = []
  const startNewChatCalls: Array<{ projectId: string; chatId: string }> = []
  let live = false

  const chatFor = (path: string): string => {
    const mapped = paths.get(path)
    if (mapped) return mapped
    const chatId = `chat-${paths.size + 1}`
    paths.set(path, chatId)
    return chatId
  }
  const seqOf = (chatId: string): number => chats.get(chatId)?.at(-1)?.seq ?? -1

  chats.set(chatFor(draftPath), [
    message({ seq: 0, role: 'user', text: 'old question' }),
    message({ seq: 1, role: 'assistant', text: 'old answer' }),
  ])

  const defer = <T>(label: PendingCall['label'], apply: () => T): Promise<T> => {
    if (live) return Promise.resolve(apply())
    return new Promise<T>((resolve) => {
      pending.push({ label, apply, settle: (value) => resolve(value as T) })
    })
  }

  const project = {
    resolveChat: (args: { filePath: string | null; tempChatId?: string }) =>
      defer('resolve', () => {
        const chatId = args.filePath ? chatFor(args.filePath) : (args.tempChatId ?? 'unsaved')
        return { projectId: 'p1', chatId, boundarySeq: boundaries.get(chatId) ?? 0 }
      }),
    appendChat: async (args: AppendArgs): Promise<boolean> => {
      const rows = chats.get(args.chatId) ?? []
      rows.push(message({ seq: seqOf(args.chatId) + 1, role: args.role, text: args.text }))
      chats.set(args.chatId, rows)
      return true
    },
    loadChat: async (args: { projectId: string; chatId: string }): Promise<ChatMessage[]> => [
      ...(chats.get(args.chatId) ?? []),
    ],
    rebindChat: (args: { projectId: string; tempChatId: string; newFilePath?: string }) =>
      defer('rebind', () => {
        const target = chatFor(args.newFilePath ?? args.tempChatId)
        const carried = boundaries.get(args.tempChatId)
        if (target !== args.tempChatId) {
          chats.set(target, [...(chats.get(target) ?? []), ...(chats.get(args.tempChatId) ?? [])])
          chats.delete(args.tempChatId)
          if (carried !== undefined && boundaries.get(target) === undefined) {
            boundaries.set(target, carried)
          }
          boundaries.delete(args.tempChatId)
        }
        return { projectId: 'p1', chatId: target, boundarySeq: boundaries.get(target) ?? 0 }
      }),
    startNewChat: (args: { projectId: string; chatId: string }) =>
      defer('boundary', () => {
        startNewChatCalls.push(args)
        const boundarySeq = seqOf(args.chatId) + 1
        boundaries.set(args.chatId, boundarySeq)
        return { projectId: 'p1', chatId: args.chatId, boundarySeq }
      }),
  }

  const has = (label: PendingCall['label']): boolean => pending.some((call) => call.label === label)
  const complete = (label: PendingCall['label']): void => {
    const index = pending.findIndex((call) => call.label === label)
    expect(index, `a pending ${label} call`).toBeGreaterThanOrEqual(0)
    const [call] = pending.splice(index, 1)
    call!.settle(call!.apply())
  }

  return {
    project: project as unknown as PdfProjectApi,
    pending,
    startNewChatCalls,
    has,
    complete,
    /** the reload speaks to a store that answers immediately */
    live: () => {
      live = true
    },
    boundaryOf: (path: string): number | undefined => boundaries.get(chatFor(path)),
  }
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function install(harness: Harness): void {
  Object.defineProperty(window, 'pdfApi', {
    value: harness.api as unknown as PdfApi,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(window, 'pdfProject', {
    value: harness.project,
    writable: true,
    configurable: true,
  })
}

function uninstall(): void {
  const globalWindow = window as unknown as { pdfApi?: PdfApi; pdfProject?: PdfProjectApi }
  delete globalWindow.pdfApi
  delete globalWindow.pdfProject
}

describe('AiPanel orchestration (mocked provider + mocked history)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    localStorage.clear()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    uninstall()
    vi.restoreAllMocks()
  })

  const mount = async (
    harness: Harness,
    filePath = '/tmp/doc.pdf',
    freshOnOpen = false,
  ): Promise<void> => {
    install(harness)
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(AiPanel, {
            api: harness.deps as unknown as PdfSkillDeps,
            onCollapse: () => {},
            filePath,
            freshOnOpen,
          }),
        }),
      )
    })
    await flush()
  }

  /** The document is saved under a new path while the panel is mounted (Save As). */
  const rerenderWithPath = async (harness: Harness, filePath: string): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          initial: 'en',
          children: createElement(AiPanel, {
            api: harness.deps as unknown as PdfSkillDeps,
            onCollapse: () => {},
            filePath,
          }),
        }),
      )
    })
    await flush()
  }

  const composer = (): HTMLTextAreaElement => {
    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()
    return textarea as HTMLTextAreaElement
  }

  const type = async (text: string): Promise<void> => {
    const textarea = composer()
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set
    await act(async () => {
      setter?.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const sendButton = (): HTMLButtonElement => {
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Send',
    )
    expect(button, 'Send button').toBeTruthy()
    return button as HTMLButtonElement
  }

  const clickSend = async (): Promise<void> => {
    await act(async () => sendButton().click())
    await flush()
  }

  const send = async (text: string): Promise<void> => {
    await type(text)
    await clickSend()
  }

  const clickLabel = async (label: string): Promise<void> => {
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
    )
    expect(button, `button "${label}"`).toBeTruthy()
    await act(async () => button!.click())
    await flush()
  }

  it('waits for a recent-chat boundary before scanning, then scans again after New chat', async () => {
    const harness = makeHarness({
      history: [message({ seq: 0, role: 'user', text: 'previous question' })],
    })
    harness.api.getPreferences.mockResolvedValue({ aiAutoSuggestions: true })
    vi.spyOn(harness.deps, 'doc').mockReturnValue({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'document content', hasEOL: false }] }),
        cleanup: () => {},
      }),
    } as never)
    let finishBoundary!: (value: { projectId: string; chatId: string; boundarySeq: number }) => void
    harness.project.startNewChat = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishBoundary = resolve
          }),
      )
      .mockResolvedValue({ projectId: 'p1', chatId: 'c1', boundarySeq: 3 })
    await mount(harness, '/tmp/doc.pdf', true)
    expect(harness.api.aiChat).not.toHaveBeenCalled()
    await act(async () => finishBoundary({ projectId: 'p1', chatId: 'c1', boundarySeq: 1 }))
    await flush()
    expect(harness.api.aiChat).toHaveBeenCalledTimes(1)
    harness.scripts.push((emit) => {
      emit.delta('answer')
      emit.done()
    })
    await send('question')
    await clickLabel('New chat')
    expect(harness.api.aiChat).toHaveBeenCalledTimes(2)
  })

  it('opens a recent document with a fresh chat and keeps its earlier conversation in History', async () => {
    const history = makeFakeHistory('/tmp/draft.pdf')
    history.live()
    const harness = makeHarness()
    harness.project = history.project
    harness.scripts.push((emit) => {
      emit.delta('fresh answer')
      emit.done()
    })
    await mount(harness, '/tmp/draft.pdf', true)
    expect(container.querySelectorAll('.ai-chat > .ai-msg')).toHaveLength(0)
    expect(container.textContent).not.toContain('old question')
    const historyButton = container.querySelector('button[aria-label="History"]')
    expect(historyButton?.getAttribute('aria-expanded')).toBe('false')
    await clickLabel('History')
    expect(container.textContent).toContain('old question')
    expect(historyButton?.getAttribute('aria-expanded')).toBe('true')
    await clickLabel('History')
    await send('fresh question')
    expect(requestText(harness.requests[0]!)).toContain('fresh question')
    expect(requestText(harness.requests[0]!)).not.toContain('old question')
    expect(container.querySelector('button[aria-label="New chat"]')).toBeTruthy()
    await clickLabel('New chat')
    expect(container.querySelectorAll('.ai-chat > .ai-msg')).toHaveLength(0)
    expect(container.querySelector('button[aria-label="History"]')).toBeTruthy()
  })

  it('restores only the active conversation for a follow-up after a reload', async () => {
    const harness = makeHarness({
      boundarySeq: 2,
      history: [
        message({ seq: 0, role: 'user', text: 'old question' }),
        message({ seq: 1, role: 'assistant', text: 'old answer' }),
        message({ seq: 2, role: 'user', text: 'new question' }),
        message({
          seq: 3,
          role: 'assistant',
          text: 'new answer',
          status: 'stopped',
          tools: [{ name: 'edit_text_block', summary: 'Edit page 1', mutated: true }],
        }),
        message({ seq: 4, role: 'user', text: 'rotate page 2' }),
        message({
          seq: 5,
          role: 'assistant',
          text: 'provider failed',
          status: 'failed',
          tools: [{ name: 'rotate_page', summary: 'Rotate page 2', mutated: true }],
        }),
      ],
    })
    harness.scripts.push((emit) => {
      emit.delta('follow-up answer')
      emit.done()
    })
    await mount(harness)
    await send('follow up')

    expect(harness.requests).toHaveLength(1)
    const request = harness.requests[0]!
    // Active conversation (4 rows) + the new user turn; nothing before the boundary
    expect(request.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    const context = requestText(request)
    expect(context).toContain('new question')
    expect(context).toContain('new answer')
    expect(context).toContain('Edit page 1 — applied to the document')
    expect(context).toContain('stopped before it finished')
    // A failed run that had already edited keeps that edit in the context too
    expect(context).toContain('Rotate page 2 — applied to the document')
    expect(context).toContain('failed before it finished')
    expect(context).not.toContain('old question')
    expect(context).not.toContain('old answer')
    // No replay: the restored edit is context, not a tool call that runs again
    expect(request.messages.some((m) => m.role === 'tool')).toBe(false)
    expect(request.messages.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(false)
  })

  it('does not seed the older conversation when the active one is empty (New chat boundary)', async () => {
    const harness = makeHarness({
      boundarySeq: 4,
      history: [
        message({ seq: 0, role: 'user', text: 'closed question' }),
        message({ seq: 1, role: 'assistant', text: 'closed answer' }),
      ],
    })
    harness.scripts.push((emit) => {
      emit.delta('fresh answer')
      emit.done()
    })
    await mount(harness)
    await send('fresh question')

    const request = harness.requests[0]!
    expect(request.messages.map((m) => m.role)).toEqual(['user'])
    expect(requestText(request)).not.toContain('closed question')
  })

  it('tells the same-session follow-up about an edit that landed before a provider failure', async () => {
    const harness = makeHarness()
    // 1) edit page 1, 2) the next provider turn fails, 3) the follow-up succeeds
    harness.scripts.push((emit) => {
      emit.tool({ id: 't1', name: 'delete_page', input: { page: 1 } })
      emit.done()
    })
    harness.scripts.push((emit) => emit.error('provider exploded'))
    harness.scripts.push((emit) => {
      emit.delta('page 1 was deleted')
      emit.done()
    })
    await mount(harness)
    await send('delete page 1')
    expect(harness.requests).toHaveLength(2)
    expect(harness.appendCalls.some((call) => call.status === 'failed')).toBe(true)
    // The action is visible and there is no blind Retry after a document change
    expect(container.textContent).toContain('Delete page 1')
    expect(container.textContent).toContain('Failed after these actions')
    const userMessage = [...container.querySelectorAll('.ai-msg-user')].at(-1)
    expect(userMessage?.querySelector('.ai-retry-btn')).toBeNull()

    await send('what changed?')
    expect(harness.requests).toHaveLength(3)
    const request = harness.requests[2]!
    // Valid pairing: the failed turn was rolled back, so only the follow-up (with
    // the applied-action context) is sent — never a stale tool_use without result
    expect(request.messages.map((m) => m.role)).toEqual(['user'])
    expect(requestText(request)).toContain('Delete page 1 — applied to the document')
    expect(requestText(request)).toContain('what changed?')
    // The edit ran exactly once: the follow-up did not replay it
    expect(harness.deps.deletePage).toHaveBeenCalledTimes(1)
    expect(request.messages.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(false)

    // Once a run completes, the failure recap is not stapled onto later messages
    harness.scripts.push((emit) => {
      emit.delta('still here')
      emit.done()
    })
    await send('one more')
    const later = harness.requests[3]!.messages.at(-1)
    expect(later?.role).toBe('user')
    expect(later?.role === 'user' ? later.text : '').not.toContain('applied to the document')
    expect(later?.role === 'user' ? later.text : '').toContain('one more')
  })

  it('does not re-read provider settings on every streamed token', async () => {
    const harness = makeHarness()
    harness.scripts.push((emit) => {
      emit.delta('one ')
      emit.delta('two ')
      emit.delta('three')
      emit.done()
    })
    await mount(harness)
    await send('count the reads')
    // mount poll + the run's own read; a per-render options object would add one
    // IPC settings read for every streamed chunk
    expect(harness.api.getAiSettings.mock.calls.length).toBeLessThanOrEqual(2)
    expect(container.textContent).toContain('one two three')
  })

  it('re-grants and re-sends the original attachment on retry', async () => {
    const harness = makeHarness()
    harness.api.pickAttachments.mockResolvedValue({ accepted: [IMAGE], rejected: [] })
    harness.api.addAttachmentPaths.mockResolvedValue({ accepted: [IMAGE], rejected: [] })
    harness.scripts.push((emit) => emit.error('network down'))
    harness.scripts.push((emit) => {
      emit.delta('image received')
      emit.done()
    })
    await mount(harness)
    await clickLabel('Attach a file')
    expect(container.querySelector('.ai-attachment-thumb img')?.getAttribute('alt')).toBe('pic.png')

    await send('describe this')
    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]!.messages[0]).toMatchObject({
      role: 'user',
      images: [{ base64: 'AAAA', mime: 'image/png' }],
    })

    // Retry re-grants the same path and re-sends the image, not a stripped request
    await clickLabel('Retry')
    expect(harness.api.addAttachmentPaths).toHaveBeenCalledWith([IMAGE.path])
    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[1]!.messages[0]).toMatchObject({
      role: 'user',
      images: [{ base64: 'AAAA', mime: 'image/png' }],
    })
  })

  it('refuses to retry when the original attachment can no longer be granted', async () => {
    const harness = makeHarness()
    harness.api.pickAttachments.mockResolvedValue({ accepted: [IMAGE], rejected: [] })
    harness.api.addAttachmentPaths.mockResolvedValue({
      accepted: [],
      rejected: ['too large'],
    })
    harness.scripts.push((emit) => emit.error('network down'))
    await mount(harness)
    await clickLabel('Attach a file')
    await send('describe this')
    expect(harness.requests).toHaveLength(1)

    await clickLabel('Retry')
    // The original attachment is gone: the panel says so and sends nothing
    expect(harness.requests).toHaveLength(1)
    expect(container.textContent).toContain('original attachment is no longer available')
  })

  it('invalidates a delayed history load when the user starts a fresh conversation', async () => {
    let resolveIds:
      ((value: { projectId: string; chatId: string; boundarySeq: number }) => void) | null = null
    let resolveLoad: ((value: ChatMessage[]) => void) | null = null
    const harness = makeHarness({
      resolveChat: () =>
        new Promise((resolve) => {
          resolveIds = resolve
        }),
      loadChat: () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
    })
    harness.scripts.push((emit) => {
      emit.delta('fresh answer')
      emit.done()
    })
    await mount(harness)
    expect(composer().placeholder).toBe('Loading the saved conversation…')

    // The conversation is still unknown: no provider request may start yet
    await type('live question')
    await clickSend()
    expect(harness.requests).toHaveLength(0)

    // An explicit fresh start does not have to wait for the read
    await clickLabel('New chat')
    // The late load resolves with an earlier conversation: it must not refill
    // the new, empty conversation
    await act(async () => {
      resolveIds?.({ projectId: 'p1', chatId: 'c1', boundarySeq: 2 })
      resolveLoad?.([
        message({ seq: 0, role: 'user', text: 'stale question' }),
        message({ seq: 1, role: 'assistant', text: 'stale answer' }),
      ])
      await Promise.resolve()
    })
    await flush()

    expect(container.querySelectorAll('.ai-chat > .ai-msg')).toHaveLength(0)
    expect(container.textContent).not.toContain('stale question')
    expect(harness.project.startNewChat).toHaveBeenCalled()

    await send('after new chat')
    expect(harness.requests).toHaveLength(1)
    expect(requestText(harness.requests[0]!)).toContain('after new chat')
    expect(requestText(harness.requests[0]!)).not.toContain('stale question')
  })

  it('surfaces a failed history load and recovers it into the empty conversation', async () => {
    const harness = makeHarness()
    harness.project.loadChat = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc failed'))
      .mockResolvedValueOnce([
        message({ seq: 0, role: 'user', text: 'recovered question' }),
        message({ seq: 1, role: 'assistant', text: 'recovered answer' }),
      ]) as unknown as PdfProjectApi['loadChat']
    harness.scripts.push((emit) => {
      emit.delta('answer after recovery')
      emit.done()
    })
    await mount(harness)
    expect(container.textContent).toContain('The saved conversation could not be loaded.')

    await clickLabel('Retry')
    expect(container.textContent).toContain('recovered question')

    await send('follow up')
    expect(requestText(harness.requests[0]!)).toContain('recovered question')
    expect(requestText(harness.requests[0]!)).toContain('follow up')
  })

  it('refuses to send until the failed load is recovered or explicitly abandoned', async () => {
    const harness = makeHarness()
    // The mount load failed; the panel does not know the conversation yet.
    harness.project.loadChat = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc failed'))
      .mockRejectedValueOnce(new Error('still locked'))
      .mockResolvedValueOnce([
        message({ seq: 0, role: 'user', text: 'earlier question' }),
        message({ seq: 1, role: 'assistant', text: 'earlier answer' }),
      ]) as unknown as PdfProjectApi['loadChat']
    harness.scripts.push((emit) => {
      emit.delta('fresh answer')
      emit.done()
    })
    await mount(harness)
    expect(container.textContent).toContain('The saved conversation could not be loaded.')

    // Typing works, sending does not: the restored turns would be missing
    await type('hello')
    expect(composer().disabled).toBe(false)
    await clickSend()
    expect(harness.requests).toHaveLength(0)
    expect(harness.project.appendChat).not.toHaveBeenCalled()
    expect(composer().value).toBe('hello')

    // A failed retry keeps the banner and the draft (nothing is wiped)
    await clickLabel('Retry')
    expect(container.textContent).toContain('The saved conversation could not be loaded.')
    expect(composer().value).toBe('hello')
    expect(harness.requests).toHaveLength(0)

    await clickLabel('Retry')
    const shown = (needle: string): number =>
      (container.querySelector('.ai-chat')?.textContent ?? '').split(needle).length - 1
    // Recovered exactly once, and the user's message was never persisted early
    expect(shown('earlier question')).toBe(1)
    expect(shown('hello')).toBe(0)

    await clickSend()
    expect(requestText(harness.requests[0]!)).toContain('earlier question')
    expect(requestText(harness.requests[0]!)).toContain('hello')
    expect(shown('hello')).toBe(1)
    expect(harness.appendCalls.filter((call) => call.text === 'hello')).toHaveLength(1)
  })

  it('recovers a rejected resolve on Retry instead of dead-ending the history', async () => {
    const harness = makeHarness({
      history: [
        message({ seq: 0, role: 'user', text: 'earlier question' }),
        message({ seq: 1, role: 'assistant', text: 'earlier answer' }),
      ],
    })
    // The ids could not be read once (lock/permission); Retry must ask again
    harness.project.resolveChat = vi
      .fn()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValue({
        projectId: 'p1',
        chatId: 'c1',
        boundarySeq: 0,
      }) as unknown as PdfProjectApi['resolveChat']
    harness.scripts.push((emit) => {
      emit.delta('fresh answer')
      emit.done()
    })
    await mount(harness)
    expect(container.textContent).toContain('The saved conversation could not be loaded.')

    await type('follow up')
    await clickSend()
    expect(harness.requests).toHaveLength(0)
    expect(harness.project.appendChat).not.toHaveBeenCalled()

    await clickLabel('Retry')
    expect(harness.project.resolveChat).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.ai-chat')?.textContent).toContain('earlier question')

    await clickSend()
    expect(requestText(harness.requests[0]!)).toContain('earlier question')
    expect(requestText(harness.requests[0]!)).toContain('follow up')
  })

  it('refuses to guess the boundary when the rebind cannot report it', async () => {
    const harness = makeHarness({
      history: [
        message({ seq: 0, role: 'user', text: 'closed question' }),
        message({ seq: 1, role: 'assistant', text: 'closed answer' }),
        message({ seq: 2, role: 'user', text: 'active question' }),
        message({ seq: 3, role: 'assistant', text: 'active answer' }),
      ],
    })
    let resolveIds:
      ((value: { projectId: string; chatId: string; boundarySeq: number }) => void) | null = null
    harness.project.resolveChat = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveIds = resolve
        }),
    ) as unknown as PdfProjectApi['resolveChat']
    // The bridge's rebind error path: the ids come back without a boundary
    harness.project.rebindChat = vi.fn(async () => ({
      projectId: 'p1',
      chatId: 'saved-chat',
    })) as unknown as PdfProjectApi['rebindChat']
    await mount(harness, '/tmp/draft.pdf')

    // Save As while the ids were still resolving
    await rerenderWithPath(harness, '/tmp/saved.pdf')
    await act(async () => {
      resolveIds?.({ projectId: 'p1', chatId: 'draft-chat', boundarySeq: 2 })
      await Promise.resolve()
    })
    await flush()

    // An unknown boundary is not "never cut": loading at 0 would feed the closed
    // conversation back into the model, so the panel reports the failure instead
    expect(container.textContent).toContain('The saved conversation could not be loaded.')
    expect(harness.project.loadChat).not.toHaveBeenCalled()
    await type('follow up')
    await clickSend()
    expect(harness.requests).toHaveLength(0)

    // Storage recovers: Retry re-reads the boundary and splits at it
    harness.project.rebindChat = vi.fn(async () => ({
      projectId: 'p1',
      chatId: 'saved-chat',
      boundarySeq: 2,
    })) as unknown as PdfProjectApi['rebindChat']
    await clickLabel('Retry')
    const chatText = (): string => container.querySelector('.ai-chat')?.textContent ?? ''
    expect(chatText()).toContain('active question')
    // The closed conversation is kept (in the earlier-conversation block), not seeded
    expect(chatText()).toContain('Earlier conversation')
    // ...and the transcript is read from the saved path's chat, not the draft id
    expect(vi.mocked(harness.project.loadChat).mock.calls.at(-1)?.[0]).toMatchObject({
      projectId: 'p1',
      chatId: 'saved-chat',
    })

    await clickSend()
    const sent = requestText(harness.requests[0]!)
    expect(sent).toContain('active question')
    expect(sent).not.toContain('closed question')
  })

  it('starts a fresh conversation even when the ids could not be resolved', async () => {
    const harness = makeHarness()
    harness.project.resolveChat = vi
      .fn()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValue({
        projectId: 'p1',
        chatId: 'c1',
        boundarySeq: 0,
      }) as unknown as PdfProjectApi['resolveChat']
    harness.project.startNewChat = vi.fn(async () => ({
      projectId: 'p1',
      chatId: 'c1',
      boundarySeq: 4,
    })) as unknown as PdfProjectApi['startNewChat']
    harness.scripts.push((emit) => {
      emit.delta('fresh answer')
      emit.done()
    })
    await mount(harness)
    expect(container.textContent).toContain('The saved conversation could not be loaded.')

    // New chat is the explicit way out: it resolves the ids again, saves the
    // boundary and lets the conversation continue instead of staying blocked
    await clickLabel('New chat')
    expect(harness.project.resolveChat).toHaveBeenCalledTimes(2)
    expect(harness.project.startNewChat).toHaveBeenCalledWith({ projectId: 'p1', chatId: 'c1' })
    expect(container.textContent).not.toContain('could not be saved')

    await send('fresh question')
    expect(harness.requests).toHaveLength(1)
    expect(harness.appendCalls.map((call) => call.text)).toEqual(['fresh question', 'fresh answer'])
  })

  it('keeps a pre-send failure visible in the earlier conversation when New chat is pending', async () => {
    const harness = makeHarness()
    let holdSettings = false
    let rejectSettings: ((error: Error) => void) | null = null
    harness.api.getAiSettings.mockImplementation((() => {
      if (!holdSettings) return Promise.resolve(READY_SETTINGS)
      return new Promise((_resolve, reject) => {
        rejectSettings = reject
      })
    }) as () => Promise<unknown>)
    await mount(harness)

    holdSettings = true
    await type('never sent')
    const sendButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Send',
    )
    await act(async () => sendButton!.click())
    await flush(2)

    // New chat cancels startup without waiting for settings to settle.
    await clickLabel('New chat')
    await act(async () => {
      rejectSettings?.(new Error('settings unavailable'))
      await Promise.resolve()
    })
    await flush()

    await clickLabel('History')
    expect(container.querySelectorAll('.ai-msg-historic')).toHaveLength(1)
    expect(container.textContent).not.toContain('settings unavailable')
    expect(container.textContent).toContain('never sent')
    expect(harness.requests).toHaveLength(0)
  })

  it('starts a new chat immediately when pending settings never resolve', async () => {
    const harness = makeHarness()
    let holdSettings = false
    harness.api.getAiSettings.mockImplementation(async () =>
      holdSettings ? new Promise(() => {}) : READY_SETTINGS,
    )
    await mount(harness)
    holdSettings = true
    await send('never sent')
    await clickLabel('New chat')
    expect(container.querySelectorAll('.ai-chat > .ai-msg')).toHaveLength(0)
    expect(harness.requests).toHaveLength(0)
  })

  it('does not start a run whose settings read resolves after New chat', async () => {
    const harness = makeHarness()
    let holdSettings = false
    const pendingSettings: Array<(value: typeof READY_SETTINGS) => void> = []
    harness.api.getAiSettings.mockImplementation(async () => {
      if (!holdSettings) return READY_SETTINGS
      return new Promise((resolve) => pendingSettings.push(resolve))
    })
    await mount(harness)
    holdSettings = true
    await type('never sent')
    const sendButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Send',
    )
    await act(async () => sendButton!.click())
    await flush(2)

    await clickLabel('New chat')
    await act(async () => {
      for (const resolve of pendingSettings.splice(0)) resolve(READY_SETTINGS)
      await Promise.resolve()
    })
    await flush()

    // The stale startup was invalidated: no provider request, empty conversation,
    // and the cancelled request left no empty reply bubble behind
    expect(harness.requests).toHaveLength(0)
    expect(container.querySelectorAll('.ai-chat > .ai-msg')).toHaveLength(0)
    await clickLabel('History')
    expect(container.textContent).toContain('Earlier conversation (1)')
  })

  it('starts a new chat without waiting for an image read and ignores its late result', async () => {
    const harness = makeHarness()
    harness.api.pickAttachments.mockResolvedValue({ accepted: [IMAGE], rejected: [] })
    let resolveImage!: (value: { ok: boolean; base64: string; mime: string }) => void
    harness.api.readAttachmentImage
      .mockResolvedValueOnce({ ok: true, base64: 'PREVIEW', mime: 'image/png' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveImage = resolve
          }),
      )
    await mount(harness)
    await clickLabel('Attach a file')
    await send('describe this')
    await clickLabel('New chat')
    expect(container.querySelectorAll('.ai-chat > .ai-msg')).toHaveLength(0)
    await act(async () => resolveImage({ ok: true, base64: 'AAAA', mime: 'image/png' }))
    await flush()
    expect(harness.requests).toHaveLength(0)
  })

  it('does not start a run whose image read resolves after the panel unmounts', async () => {
    const harness = makeHarness()
    harness.api.pickAttachments.mockResolvedValue({ accepted: [IMAGE], rejected: [] })
    let resolveImage: ((value: { ok: boolean; base64: string; mime: string }) => void) | null = null
    harness.api.readAttachmentImage
      .mockResolvedValueOnce({ ok: true, base64: 'PREVIEW', mime: 'image/png' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveImage = resolve
          }),
      )
    await mount(harness)
    await clickLabel('Attach a file')
    await type('describe this')
    const sendButton = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Send',
    )
    await act(async () => sendButton!.click())
    await flush(2)

    await act(async () => root.unmount())
    await act(async () => {
      resolveImage?.({ ok: true, base64: 'AAAA', mime: 'image/png' })
      await Promise.resolve()
    })
    await flush()
    // The unmounted panel must not issue the provider request
    expect(harness.requests).toHaveLength(0)
  })

  it("does not carry one document's conversation into the replacement document", async () => {
    const first = makeHarness({
      history: [
        message({ seq: 0, role: 'user', text: 'doc A question' }),
        message({ seq: 1, role: 'assistant', text: 'doc A answer' }),
      ],
    })
    first.scripts.push((emit) => {
      emit.delta('A follow-up')
      emit.done()
    })
    await mount(first, '/tmp/a.pdf')
    await send('more about A')
    expect(requestText(first.requests[0]!)).toContain('doc A question')

    // The view is replaced for another document: a fresh panel and a fresh chat
    await act(async () => root.unmount())
    root = createRoot(container)
    const second = makeHarness()
    second.scripts.push((emit) => {
      emit.delta('B answer')
      emit.done()
    })
    await mount(second, '/tmp/b.pdf')
    await send('question about B')

    expect(second.requests).toHaveLength(1)
    expect(requestText(second.requests[0]!)).not.toContain('doc A')
    expect(requestText(second.requests[0]!)).toContain('question about B')
  })

  it('surfaces a failed history write and retries it once, in order', async () => {
    const harness = makeHarness()
    const attempted: string[] = []
    harness.project.appendChat = vi.fn(async (args: AppendArgs) => {
      attempted.push(`${args.role}:${args.text}`)
      // the first user record is rejected; everything after succeeds
      return attempted.length !== 1
    }) as unknown as PdfProjectApi['appendChat']
    harness.scripts.push((emit) => {
      emit.delta('saved answer')
      emit.done()
    })
    await mount(harness)
    await send('save me')

    expect(container.textContent).toContain('This conversation could not be saved to disk.')
    // The reply waited behind the unsaved user record instead of inverting order
    expect(attempted).toEqual(['user:save me'])

    await clickLabel('Retry')
    expect(attempted).toEqual(['user:save me', 'user:save me', 'assistant:saved answer'])
    expect(container.textContent).not.toContain('could not be saved')
    // A second Retry click cannot duplicate anything (the banner is gone)
    expect(attempted).toHaveLength(3)
  })

  it('defers the New-chat boundary until the closed conversation is recovered', async () => {
    const harness = makeHarness()
    let recovered = false
    const order: string[] = []
    harness.project.appendChat = vi.fn(async (args: AppendArgs) => {
      order.push(`append:${args.role}`)
      return recovered
    }) as unknown as PdfProjectApi['appendChat']
    harness.project.startNewChat = vi.fn(async () => {
      order.push('boundary')
      return { projectId: 'p1', chatId: 'c1', boundarySeq: 4 }
    }) as unknown as PdfProjectApi['startNewChat']
    harness.scripts.push((emit) => {
      emit.delta('answer')
      emit.done()
    })
    await mount(harness)
    await send('closed question')
    expect(container.textContent).toContain('could not be saved')

    // New chat cannot write a boundary that would leave the closed records after it
    await clickLabel('New chat')
    expect(order).toEqual(['append:user'])
    expect(container.textContent).toContain('could not be saved')

    recovered = true
    await clickLabel('Retry')
    // Recovered records first, then the durable boundary, in the same chain
    expect(order).toEqual(['append:user', 'append:user', 'append:assistant', 'boundary'])
  })

  it('surfaces a rejected history IPC call (throw) and recovers on retry', async () => {
    const harness = makeHarness()
    const attempted: string[] = []
    harness.project.appendChat = vi.fn(async (args: AppendArgs) => {
      attempted.push(`${args.role}:${args.text}`)
      if (attempted.length === 1) throw new Error('ipc rejected')
      return true
    }) as unknown as PdfProjectApi['appendChat']
    harness.scripts.push((emit) => {
      emit.delta('answer')
      emit.done()
    })
    await mount(harness)
    await send('hello')

    expect(container.textContent).toContain('This conversation could not be saved to disk.')
    await clickLabel('Retry')
    expect(attempted).toEqual(['user:hello', 'user:hello', 'assistant:answer'])
  })

  it('blocks sending while the New-chat boundary is unsaved, and no write overtakes it', async () => {
    const harness = makeHarness()
    const order: string[] = []
    let boundaryAttempts = 0
    harness.project.appendChat = vi.fn(async (args: AppendArgs) => {
      order.push(`append:${args.role}:${args.text}`)
      return true
    }) as unknown as PdfProjectApi['appendChat']
    harness.project.startNewChat = vi.fn(async () => {
      boundaryAttempts += 1
      // the boundary write is locked twice before it succeeds
      if (boundaryAttempts < 3) throw new Error('ipc rejected')
      order.push('boundary')
      return { projectId: 'p1', chatId: 'c1', boundarySeq: 4 }
    }) as unknown as PdfProjectApi['startNewChat']
    harness.scripts.push((emit) => {
      emit.delta('first answer')
      emit.done()
    })
    harness.scripts.push((emit) => {
      emit.delta('second answer')
      emit.done()
    })
    await mount(harness)
    await send('closed question')
    expect(order).toEqual(['append:user:closed question', 'append:assistant:first answer'])

    await clickLabel('New chat')
    expect(boundaryAttempts).toBe(1)
    // The boundary is not on disk: the banner stays visible and sending is refused
    expect(container.textContent).toContain(
      'Starting a new conversation could not be saved. Retry before sending.',
    )
    await type('second question')
    await clickSend()
    expect(harness.requests).toHaveLength(1)
    expect(order).toHaveLength(2)
    expect(composer().value).toBe('second question')

    // A failed retry keeps the banner and cannot duplicate a record
    await clickLabel('Retry')
    expect(boundaryAttempts).toBe(2)
    expect(container.textContent).toContain('Starting a new conversation could not be saved.')
    expect(order).toHaveLength(2)

    await clickLabel('Retry')
    expect(boundaryAttempts).toBe(3)
    expect(container.textContent).not.toContain('could not be saved')
    // The message of the new conversation is written only after its boundary
    await clickSend()
    expect(harness.requests).toHaveLength(2)
    expect(order).toEqual([
      'append:user:closed question',
      'append:assistant:first answer',
      'boundary',
      'append:user:second question',
      'append:assistant:second answer',
    ])
  })

  it('re-grants and re-sends a non-image attachment on retry', async () => {
    const harness = makeHarness()
    const TEXT_FILE: AttachmentMeta = {
      path: '/tmp/notes.txt',
      name: 'notes.txt',
      ext: 'txt',
      sizeBytes: 2048,
    }
    harness.api.pickAttachments.mockResolvedValue({ accepted: [TEXT_FILE], rejected: [] })
    harness.api.addAttachmentPaths.mockResolvedValue({ accepted: [TEXT_FILE], rejected: [] })
    harness.scripts.push((emit) => emit.error('network down'))
    harness.scripts.push((emit) => {
      emit.delta('file received')
      emit.done()
    })
    await mount(harness)
    await clickLabel('Attach a file')
    await send('summarize this file')

    // A text attachment travels as a model-visible attachment list (no image payload)
    expect(harness.requests).toHaveLength(1)
    const firstUser = harness.requests[0]!.messages[0]
    expect(firstUser.role === 'user' ? firstUser.text : '').toContain('notes.txt')
    expect(harness.api.readAttachmentImage).not.toHaveBeenCalled()
    expect(harness.requests[0]!.messages[0]).not.toHaveProperty('images')

    await clickLabel('Retry')
    // Same request: the file is re-granted before the second send
    expect(harness.api.addAttachmentPaths).toHaveBeenCalledWith([TEXT_FILE.path])
    expect(harness.requests).toHaveLength(2)
    const retriedUser = harness.requests[1]!.messages[0]
    expect(retriedUser.role === 'user' ? retriedUser.text : '').toContain('notes.txt')
    expect(retriedUser.role).toBe('user')
    expect(retriedUser.role === 'user' ? retriedUser.text : '').toMatch(/^summarize this file/)
    expect(harness.requests[1]!.messages[0]).not.toHaveProperty('images')
  })

  it('keeps tool-detail scrolling out of the conversation scroll state', async () => {
    const harness = makeHarness({
      history: [
        message({ seq: 0, role: 'user', text: 'read the pages' }),
        message({
          seq: 1,
          role: 'assistant',
          text: 'done',
          tools: [{ name: 'read_pages', summary: 'Read pages 1-2', output: 'x'.repeat(400) }],
        }),
      ],
    })
    await mount(harness)
    const chat = container.querySelector('.ai-chat') as HTMLDivElement
    // Away from the bottom: any conversation scroll would reveal Jump to latest
    Object.defineProperty(chat, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(chat, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(chat, 'scrollTop', { value: 0, configurable: true, writable: true })

    await clickLabel('Read pages 1-2: show details')
    const detail = container.querySelector('.ai-tool-output-pre') as HTMLElement | null
    expect(detail).toBeTruthy()
    await act(async () => detail!.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(container.querySelector('.ai-jump-latest')).toBeNull()

    // The conversation's own scroll still offers the control
    await act(async () => chat.dispatchEvent(new Event('scroll')))
    expect(container.querySelector('.ai-jump-latest')).toBeTruthy()
  })

  /**
   * Save As and New chat both re-point the same transcript. Whichever IPC is
   * slower must not decide the active conversation: the boundary has to end up on
   * the chat that owns the rows, or a reload reads the closed conversation as
   * active and feeds it back into the model.
   */
  const finishNewChatAndReload = async (
    history: ReturnType<typeof makeFakeHistory>,
  ): Promise<void> => {
    // In this session the boundary must be durable and the closed rows stay
    // reachable (display only) instead of waiting for a reload.
    expect(container.textContent).not.toContain('Starting a new conversation could not be saved')
    expect(history.boundaryOf('/tmp/saved.pdf')).toBe(2)
    await clickLabel('History')
    expect(container.textContent).toContain('Earlier conversation (2)')

    // Reload: a fresh panel over the same store reads the durable boundary
    await act(async () => root.unmount())
    root = createRoot(container)
    history.live()
    const reload = makeHarness()
    reload.project = history.project
    reload.scripts.push((emit) => {
      emit.delta('after reload')
      emit.done()
    })
    await mount(reload, '/tmp/saved.pdf')
    expect(container.textContent).toContain('Earlier conversation (2)')

    await send('follow up')
    const request = requestText(reload.requests[0]!)
    expect(request).toContain('follow up')
    expect(request).not.toContain('old question')
    expect(request).not.toContain('old answer')
  }

  it('keeps the New-chat boundary with the transcript when the Save As rebind lands first', async () => {
    const history = makeFakeHistory('/tmp/draft.pdf')
    const harness = makeHarness()
    harness.project = history.project
    await mount(harness, '/tmp/draft.pdf')
    // The ids are still pending when the document is saved elsewhere...
    await rerenderWithPath(harness, '/tmp/saved.pdf')
    // ...and the user starts a fresh conversation before anything resolved
    await clickLabel('New chat')

    history.complete('resolve')
    await flush()
    // The rebind is issued first (the panel never learned the boundary yet), so
    // the boundary must be written for the chat the rebind moved the rows to
    while (history.has('rebind')) {
      history.complete('rebind')
      await flush()
    }
    history.complete('boundary')
    await flush()

    expect(history.startNewChatCalls.at(-1)).toMatchObject({ projectId: 'p1', chatId: 'chat-2' })
    await finishNewChatAndReload(history)
  })

  it('keeps the New-chat boundary with the transcript when the boundary lands first', async () => {
    const history = makeFakeHistory('/tmp/draft.pdf')
    const harness = makeHarness()
    harness.project = history.project
    await mount(harness, '/tmp/draft.pdf')
    history.complete('resolve')
    await flush()
    // New chat first: the boundary is written for the chat that holds the rows...
    await clickLabel('New chat')
    await flush()
    expect(history.has('boundary')).toBe(true)
    // ...then the document is saved elsewhere while that write is in flight
    await rerenderWithPath(harness, '/tmp/saved.pdf')

    history.complete('boundary')
    await flush()
    history.complete('rebind')
    await flush()

    // The rebind carried the boundary over with the rows
    expect(history.startNewChatCalls.at(-1)).toMatchObject({ projectId: 'p1', chatId: 'chat-1' })
    await finishNewChatAndReload(history)
  })

  it.each(['append-first', 'rebind-first', 'failed-append'])(
    'keeps chat records ordered and reachable across Save As (%s)',
    async (order) => {
      const history = makeFakeHistory('/tmp/draft.pdf')
      history.live()
      const harness = makeHarness()
      harness.project = history.project
      const originalAppend = history.project.appendChat
      const originalRebind = history.project.rebindChat
      const events: string[] = []
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let firstAppend = true
      history.project.appendChat = vi.fn(async (args) => {
        events.push(`append:${args.chatId}:${args.role}`)
        if (firstAppend) {
          firstAppend = false
          if (order === 'append-first') await gate
          if (order === 'failed-append') return false
        }
        return originalAppend(args)
      })
      history.project.rebindChat = vi.fn(async (args) => {
        events.push('rebind')
        if (order === 'rebind-first') await gate
        return originalRebind(args)
      })
      harness.scripts.push((emit) => {
        emit.delta('saved answer')
        emit.done()
      })
      await mount(harness, '/tmp/draft.pdf')
      if (order === 'rebind-first') await rerenderWithPath(harness, '/tmp/saved.pdf')
      await send('saved question')
      if (order !== 'rebind-first') await rerenderWithPath(harness, '/tmp/saved.pdf')
      if (order === 'append-first') expect(events).toEqual(['append:chat-1:user'])
      if (order === 'rebind-first') expect(events).toEqual(['rebind'])
      release()
      await flush()
      if (order === 'failed-append') {
        const retry = container.querySelector('.ai-history-notice button') as HTMLButtonElement
        expect(retry).toBeTruthy()
        await act(async () => retry.click())
        await flush()
      }
      const ids = await history.project.resolveChat({ filePath: '/tmp/saved.pdf' })
      const rows = await history.project.loadChat({ projectId: ids.projectId, chatId: ids.chatId })
      expect(rows.map((row) => row.text)).toEqual([
        'old question',
        'old answer',
        'saved question',
        'saved answer',
      ])
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
      await act(async () => root.unmount())
      root = createRoot(container)
      const reload = makeHarness()
      reload.project = history.project
      await mount(reload, '/tmp/saved.pdf')
      expect(container.textContent).toContain('saved question')
      expect(container.textContent).toContain('saved answer')
    },
  )

  it('shows the earlier conversation in this session when New chat lands before a delayed load', async () => {
    const history = makeFakeHistory('/tmp/draft.pdf')
    const harness = makeHarness()
    harness.project = history.project
    harness.scripts.push((emit) => {
      emit.delta('fresh answer')
      emit.done()
    })
    await mount(harness, '/tmp/draft.pdf')
    expect(composer().placeholder).toBe('Loading the saved conversation…')

    // New chat during the delayed initialization: its stale load is discarded
    await clickLabel('New chat')
    history.complete('resolve')
    await flush()
    history.complete('boundary')
    await flush()

    // The closed rows are reachable right away (no reload needed) and nothing of
    // the new conversation is shown yet
    await clickLabel('History')
    expect(container.textContent).toContain('Earlier conversation (2)')
    expect(container.querySelectorAll('.ai-chat > .ai-msg')).toHaveLength(0)

    await send('fresh question')
    const request = harness.requests[0]!
    expect(request.messages.map((m) => m.role)).toEqual(['user'])
    expect(requestText(request)).toContain('fresh question')
    expect(requestText(request)).not.toContain('old question')
    expect(requestText(request)).not.toContain('old answer')
  })

  it('declares scroll containment for every nested scroll area', () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/ui/src/ai-panel.css'),
      'utf8',
    )
    for (const [selector, rule] of [
      ['.ai-tool-output-pre', 'overscroll-behavior: contain'],
      ['.ai-process-drawer', 'overscroll-behavior: contain'],
      ['.ai-process-thought-preview', 'overscroll-behavior: contain'],
      ['.ai-md-table-wrap', 'overscroll-behavior-x: contain'],
    ] as const) {
      const start = css.indexOf(`${selector} {`)
      expect(start, `${selector} block`).toBeGreaterThanOrEqual(0)
      const block = css.slice(start, css.indexOf('}', start))
      expect(block, `${selector} chains its scroll into the chat`).toContain(rule)
    }
  })

  it('keeps Jump to latest reserved above the newest message (no overlay class)', async () => {
    const harness = makeHarness()
    await mount(harness)
    const chat = container.querySelector('.ai-chat') as HTMLDivElement
    expect(chat.className).not.toContain('ai-chat-has-jump')
    // Simulate a reader who scrolled away
    Object.defineProperty(chat, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(chat, 'clientHeight', { value: 300, configurable: true })
    Object.defineProperty(chat, 'scrollTop', { value: 0, configurable: true, writable: true })
    await act(async () => {
      chat.dispatchEvent(new Event('scroll'))
    })
    expect(chat.className).toContain('ai-chat-has-jump')
    expect(container.querySelector('.ai-jump-latest')).toBeTruthy()
  })
})
