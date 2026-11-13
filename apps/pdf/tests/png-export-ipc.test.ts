// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type FakeWebContents = { id: number }
type IpcHandler = (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const showOpenDialog = vi.hoisted(() => vi.fn())
const linkFailure = vi.hoisted(() => ({
  target: '',
  wait: undefined as Promise<void> | undefined,
  onLink: undefined as (() => void) | undefined,
}))
let nextId = 1
let dir = ''

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: async (
      temp: Parameters<typeof actual.link>[0],
      target: Parameters<typeof actual.link>[1],
    ) => {
      if (String(target) === linkFailure.target) throw new Error('injected PNG publish failure')
      linkFailure.onLink?.()
      await linkFailure.wait
      return actual.link(temp, target)
    },
  }
})

vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: vi.fn(() => new Promise(() => {})) },
  dialog: { showOpenDialog },
  nativeTheme: { shouldUseDarkColors: true },
  shell: {},
  BrowserWindow: class {
    static fromWebContents = vi.fn(() => null)
    static getFocusedWindow = vi.fn(() => null)
  },
  WebContentsView: class {
    webContents = {
      id: nextId++,
      once: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }
    setBackgroundColor = vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

import { createPdfView } from '../src/main/pdf-main'
import { PDF_CHANNELS } from '../src/shared/ipc'

const invoke = (channel: string, sender: FakeWebContents, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return handler({ sender }, ...args)
}

async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'pdf-png-export-'))
  showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] })
  return { first: createPdfView().webContents, second: createPdfView().webContents }
}

async function begin(sender: FakeWebContents, pageNumbers: number[], baseName = 'book') {
  return invoke(PDF_CHANNELS.beginExportImages, sender, { pageNumbers, baseName }) as Promise<{
    ok: boolean
    canceled?: boolean
    error?: string
    exportId?: string
    savedDir?: string
    count?: number
  }>
}

async function writePage(sender: FakeWebContents, exportId: string, index: number, data: string) {
  return invoke(PDF_CHANNELS.writeExportImage, sender, {
    exportId,
    index,
    image: data,
  }) as Promise<{
    ok: boolean
    error?: string
  }>
}

async function finish(sender: FakeWebContents, exportId: string) {
  return invoke(PDF_CHANNELS.finishExportImages, sender, { exportId }) as Promise<{
    ok: boolean
    error?: string
    savedDir?: string
    count?: number
  }>
}

async function cancel(sender: FakeWebContents, exportId: string) {
  return invoke(PDF_CHANNELS.cancelExportImages, sender, { exportId })
}

afterEach(() => {
  showOpenDialog.mockReset()
  linkFailure.target = ''
  linkFailure.wait = undefined
  linkFailure.onLink = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('PNG export IPC', () => {
  it('refuses an existing PNG before rendering and preserves its bytes', async () => {
    const { first } = await setup()
    const target = join(dir, 'book-p1.png')
    const sentinel = Buffer.from('existing image')
    writeFileSync(target, sentinel)

    expect(await begin(first, [1])).toEqual({
      ok: false,
      error: `pdf: file already exists: ${target}`,
    })
    expect(readFileSync(target)).toEqual(sentinel)
    expect(readdirSync(dir)).toEqual(['book-p1.png'])
  })

  it('does not clobber a PNG created after the initial collision check', async () => {
    const { first } = await setup()
    const started = await begin(first, [1])
    expect(started.ok).toBe(true)
    const target = join(dir, 'book-p1.png')
    const sentinel = Buffer.from('racing writer')
    writeFileSync(target, sentinel)

    expect(
      await writePage(first, started.exportId!, 0, Buffer.from('ours').toString('base64')),
    ).toEqual({ ok: false, error: `pdf: file already exists: ${target}` })
    expect(readFileSync(target)).toEqual(sentinel)
    expect(readdirSync(dir)).toEqual(['book-p1.png'])
  })

  it('removes only this export’s earlier outputs after a partial publish failure', async () => {
    const { first } = await setup()
    const started = await begin(first, [1, 2])
    expect(started.ok).toBe(true)
    const firstTarget = join(dir, 'book-p1.png')
    const secondTarget = join(dir, 'book-p2.png')

    expect(
      await writePage(first, started.exportId!, 0, Buffer.from('first page').toString('base64')),
    ).toEqual({
      ok: true,
    })
    linkFailure.target = secondTarget
    expect(
      await writePage(first, started.exportId!, 1, Buffer.from('second page').toString('base64')),
    ).toEqual({ ok: false, error: 'injected PNG publish failure' })

    expect(readdirSync(dir)).toEqual([])
    expect(() => readFileSync(firstTarget)).toThrow()
    expect(() => readFileSync(secondTarget)).toThrow()
  })

  it('removes earlier outputs when rendering is cancelled after a page was written', async () => {
    const { first } = await setup()
    const started = await begin(first, [1, 2])
    expect(started.ok).toBe(true)
    expect(
      await writePage(first, started.exportId!, 0, Buffer.from('first page').toString('base64')),
    ).toEqual({
      ok: true,
    })

    expect(await cancel(first, started.exportId!)).toEqual({ ok: true })
    expect(readdirSync(dir)).toEqual([])
  })

  it.each(['cancel', 'failure'])(
    'preserves another process’s replacement during %s cleanup',
    async (action) => {
      const { first } = await setup()
      const started = await begin(first, [1, 2])
      const id = started.exportId!
      expect(await writePage(first, id, 0, Buffer.from('ours').toString('base64'))).toEqual({
        ok: true,
      })
      const replacement = join(dir, 'replacement.png')
      const target = join(dir, 'book-p1.png')
      writeFileSync(replacement, 'external replacement')
      renameSync(replacement, target)
      if (action === 'cancel') {
        await cancel(first, id)
      } else {
        linkFailure.target = join(dir, 'book-p2.png')
        expect((await writePage(first, id, 1, Buffer.from('ours').toString('base64'))).ok).toBe(
          false,
        )
      }
      expect(readFileSync(target, 'utf8')).toBe('external replacement')
    },
  )

  it('cleans up once when cancelled while a page write is pending', async () => {
    const { first } = await setup()
    const started = await begin(first, [1])
    let release!: () => void
    linkFailure.wait = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const linkStarted = new Promise<void>((resolve) => {
      entered = resolve
    })
    linkFailure.onLink = entered
    const writing = writePage(first, started.exportId!, 0, Buffer.from('ours').toString('base64'))
    await linkStarted
    const cancelling = cancel(first, started.exportId!)
    release()
    expect((await writing).ok).toBe(false)
    expect(await cancelling).toEqual({ ok: true })
    expect(readdirSync(dir)).toEqual([])
  })

  it('binds an export session to its originating PDF view and publishes in requested order', async () => {
    const { first, second } = await setup()
    const started = await begin(first, [4, 2])
    expect(started.ok).toBe(true)
    const id = started.exportId!
    expect(await writePage(second, id, 0, Buffer.from('wrong view').toString('base64'))).toEqual({
      ok: false,
      error: 'pdf: PNG export session not found for this view',
    })
    expect(await writePage(first, id, 0, Buffer.from('page four').toString('base64'))).toEqual({
      ok: true,
    })
    expect(await writePage(first, id, 1, Buffer.from('page two').toString('base64'))).toEqual({
      ok: true,
    })
    expect(await finish(first, id)).toEqual({ ok: true, savedDir: dir, count: 2 })
    expect(readFileSync(join(dir, 'book-p4.png'))).toEqual(Buffer.from('page four'))
    expect(readFileSync(join(dir, 'book-p2.png'))).toEqual(Buffer.from('page two'))
    expect(readdirSync(dir).sort()).toEqual(['book-p2.png', 'book-p4.png'])
  })
})
