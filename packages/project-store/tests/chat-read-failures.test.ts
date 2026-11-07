import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const controls = vi.hoisted(() => ({
  sourceReadFailures: new Set<string>(),
  shortRead: { active: false, calls: 0, payload: '' },
  /** injected errno for the next readSync call (a locked/permission-failing transcript read) */
  readSyncError: null as string | null,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((filePath: string | URL, encoding?: BufferEncoding) => {
      if (controls.sourceReadFailures.has(String(filePath))) {
        throw Object.assign(new Error('source read failed'), { code: 'EIO' })
      }
      return encoding ? actual.readFileSync(filePath, encoding) : actual.readFileSync(filePath)
    }),
    readSync: vi.fn(
      (
        fd: number,
        buffer: ArrayBufferView,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        if (controls.readSyncError) {
          const code = controls.readSyncError
          controls.readSyncError = null
          throw Object.assign(new Error(`chat read failed: ${code}`), { code })
        }
        if (!controls.shortRead.active)
          return actual.readSync(fd, bytes as NodeJS.ArrayBufferView, offset, length, position)
        controls.shortRead.calls++
        if (controls.shortRead.calls > 1) return 0
        bytes.fill(0x20, offset, offset + length)
        const payload = Buffer.from(controls.shortRead.payload)
        payload.copy(bytes, offset)
        return payload.length
      },
    ),
  }
})

import { ProjectStore } from '../src/store.js'

let tmpDir: string
let store: ProjectStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'project-store-read-'))
  store = new ProjectStore(tmpDir)
  store.ensureDefaultProject()
  controls.sourceReadFailures.clear()
  controls.shortRead.active = false
  controls.shortRead.calls = 0
  controls.shortRead.payload = ''
  controls.readSyncError = null
})

afterEach(() => {
  controls.sourceReadFailures.clear()
  controls.shortRead.active = false
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('chat read failures', () => {
  it('keeps the source file when a merge cannot read its history', async () => {
    const chatsDir = join(tmpDir, 'projects', 'default', 'chats')
    mkdirSync(chatsDir, { recursive: true })
    store.appendChatMessage('default', 'target-chat', { role: 'assistant', text: 'existing' })
    const sourcePath = join(chatsDir, 'unsaved-read-failure.jsonl')
    const source = `${JSON.stringify({ seq: 0, ts: '', role: 'user', text: 'keep me' })}\n`
    writeFileSync(sourcePath, source, 'utf8')
    controls.sourceReadFailures.add(sourcePath)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      store.rebindChat('default', 'unsaved-read-failure', 'target-chat')
    } finally {
      warn.mockRestore()
    }

    controls.sourceReadFailures.clear()
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    expect(existsSync(sourcePath)).toBe(true)
    expect(actual.readFileSync(sourcePath, 'utf8')).toBe(source)
    expect(store.loadChat('default', 'target-chat').map((message) => message.text)).toEqual([
      'existing',
    ])
    store.appendChatMessage('default', 'target-chat', { role: 'user', text: 'after failure' })
    expect(store.loadChat('default', 'target-chat').map((message) => message.seq)).toEqual([0, 1])
  })

  it('fails the read instead of parsing a partial chunk after readSync reaches EOF', () => {
    const chatsDir = join(tmpDir, 'projects', 'default', 'chats')
    mkdirSync(chatsDir, { recursive: true })
    const chatPath = join(chatsDir, 'short-read.jsonl')
    const payload = JSON.stringify({ seq: 0, ts: '', role: 'user', text: 'partial' })
    writeFileSync(chatPath, payload + ' '.repeat(300), 'utf8')
    controls.shortRead.active = true
    controls.shortRead.payload = payload

    // A truncated read is a read failure: it must not look like a parse result
    // (and must never surface a half-written record)
    expect(() => store.loadChat('default', 'short-read', 1)).toThrow(
      /Unexpected end of chat history/,
    )
    expect(controls.shortRead.calls).toBe(2)
  })

  const writeChat = (chatId: string, texts: string[]): string => {
    const chatsDir = join(tmpDir, 'projects', 'default', 'chats')
    mkdirSync(chatsDir, { recursive: true })
    const chatPath = join(chatsDir, `${chatId}.jsonl`)
    const lines = texts.map(
      (text, seq) => `${JSON.stringify({ seq, ts: '', role: 'user', text })}\n`,
    )
    writeFileSync(chatPath, lines.join(''), 'utf8')
    return chatPath
  }

  it('propagates a transcript read failure instead of reporting an empty chat', () => {
    writeChat('locked-chat', ['first question'])
    controls.readSyncError = 'EACCES'
    // The caller (IPC → panel) must be able to say the conversation failed to
    // load; a silent [] would look like a brand new chat.
    expect(() => store.loadChat('default', 'locked-chat')).toThrow(/chat read failed: EACCES/)
    // The failed read is not cached: a later attempt returns the transcript
    expect(store.loadChat('default', 'locked-chat').map((m) => m.text)).toEqual(['first question'])
  })

  it('treats a transcript removed during the read as empty', () => {
    writeChat('vanished-chat', ['gone soon'])
    controls.readSyncError = 'ENOENT'
    expect(store.loadChat('default', 'vanished-chat')).toEqual([])
  })

  it('does not append a record when the existing seq cannot be read', () => {
    writeChat('busy-chat', ['already here'])
    controls.readSyncError = 'EBUSY'
    // A guessed seq would corrupt the transcript order, so the write fails instead
    expect(store.appendChatMessage('default', 'busy-chat', { role: 'assistant', text: 'x' })).toBe(
      false,
    )
    expect(store.loadChat('default', 'busy-chat').map((m) => m.text)).toEqual(['already here'])
  })

  it('rejects a New-chat boundary that cannot be placed after the last record', () => {
    writeChat('perm-chat', ['first question'])
    controls.readSyncError = 'EPERM'
    // The boundary must never be guessed: the IPC call rejects and the panel
    // keeps the retryable banner
    expect(() => store.startNewChat('default', 'perm-chat')).toThrow(/chat read failed: EPERM/)
    expect(store.chatBoundary('perm-chat')).toBe(0)
  })

  const indexPath = (): string => join(tmpDir, 'projects', 'index.json')

  it('fails a boundary read instead of reporting "never cut" when the index is locked', () => {
    store.appendChatMessage('default', 'cut-chat', { role: 'user', text: 'closed question' })
    store.appendChatMessage('default', 'cut-chat', { role: 'assistant', text: 'closed answer' })
    expect(store.startNewChat('default', 'cut-chat')).toBe(2)
    controls.sourceReadFailures.add(indexPath())

    // 0 would read as "the whole transcript is the active conversation", which
    // silently feeds the closed conversation back into the model
    expect(() => store.chatBoundary('cut-chat')).toThrow(/source read failed/)
    expect(() => store.resolveChatForFile('/docs/report.pdf')).toThrow(/source read failed/)
  })

  it('does not overwrite an index it could not read', () => {
    store.appendChatMessage('default', 'kept-chat', { role: 'user', text: 'kept question' })
    store.startNewChat('default', 'kept-chat')
    const first = store.resolveChatForFile('/docs/kept.pdf')
    const before = readFileSync(indexPath(), 'utf8')

    controls.sourceReadFailures.add(indexPath())
    // A read-modify-write built on the empty default would erase every mapping
    expect(() => store.resolveChatForFile('/docs/other.pdf')).toThrow(/source read failed/)
    expect(() => store.fileRenamed('/docs/kept.pdf', '/docs/moved.pdf')).toThrow(
      /source read failed/,
    )
    controls.sourceReadFailures.clear()

    expect(readFileSync(indexPath(), 'utf8')).toBe(before)
    expect(store.resolveChatForFile('/docs/kept.pdf')).toEqual(first)
    expect(store.chatBoundary('kept-chat')).toBe(1)
  })

  it('refuses strict history reads on a corrupt index and leaves its bytes alone', () => {
    store.appendChatMessage('default', 'kept-chat', { role: 'user', text: 'kept question' })
    store.startNewChat('default', 'kept-chat')
    const first = store.resolveChatForFile('/docs/kept.pdf')
    const corrupt = '{ not json'
    writeFileSync(indexPath(), corrupt, 'utf8')

    // Malformed bytes are not an empty index: answering 0 or deriving a new chat
    // would re-seed the closed conversation, and a read-modify-write would erase
    // every mapping and boundary still stored in the file.
    expect(() => store.resolveChatForFile('/docs/kept.pdf')).toThrow(/not valid JSON/)
    expect(() => store.chatBoundary('kept-chat')).toThrow(/not valid JSON/)
    expect(() => store.startNewChat('default', 'kept-chat')).toThrow(/not valid JSON/)
    expect(() => store.fileRenamed('/docs/kept.pdf', '/docs/moved.pdf')).toThrow(/not valid JSON/)
    expect(readFileSync(indexPath(), 'utf8')).toBe(corrupt)

    // Display-only reads stay tolerant (project lists do not decide a conversation)
    expect(store.listProjects()).toEqual([])

    // A repaired index is read again: the failure is recoverable, nothing was lost
    writeFileSync(
      indexPath(),
      JSON.stringify({
        projects: [],
        fileMap: {},
        chatIdByPath: { '/docs/kept.pdf': first.chatId },
        chatBoundaryByChatId: { 'kept-chat': 1 },
      }),
      'utf8',
    )
    expect(store.resolveChatForFile('/docs/kept.pdf')).toEqual(first)
    expect(store.chatBoundary('kept-chat')).toBe(1)
  })

  it('initializes an index that does not exist yet (ENOENT is not corruption)', () => {
    rmSync(indexPath(), { force: true })
    expect(store.resolveChatForFile('/docs/fresh.pdf').boundarySeq).toBe(0)
    expect(existsSync(indexPath())).toBe(true)
    expect(JSON.parse(readFileSync(indexPath(), 'utf8')).chatIdByPath).toBeDefined()
  })
})
