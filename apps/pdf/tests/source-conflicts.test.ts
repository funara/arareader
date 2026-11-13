// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

const handlers = new Map<
  string,
  (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown
>()
const showSaveDialog = vi.hoisted(() => vi.fn())
let nextId = 1
let tempDir = ''

interface FakeWebContents {
  id: number
  once: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  listeners: Map<string, () => void>
}

let lastContents: FakeWebContents

function makeWebContents(): FakeWebContents {
  const listeners = new Map<string, () => void>()
  lastContents = {
    id: nextId++,
    once: vi.fn((event: string, handler: () => void) => listeners.set(event, handler)),
    on: vi.fn(),
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(),
    listeners,
  }
  return lastContents
}

vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: vi.fn(() => new Promise(() => {})) },
  dialog: { showSaveDialog: showSaveDialog, showMessageBox: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
  shell: {},
  BrowserWindow: class {
    static fromWebContents = vi.fn(() => null)
    static getFocusedWindow = vi.fn(() => null)
  },
  WebContentsView: class {
    webContents = makeWebContents()
    setBackgroundColor = vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: never, ...args: never[]) => unknown) =>
      handlers.set(channel, handler as never),
    ),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

import { createPdfView } from '../src/main/pdf-main'
import { PDF_CHANNELS } from '../src/shared/ipc'

const invoke = (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return handler({ sender: lastContents }, ...args)
}

async function makePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create()
  pdf.addPage([100, 100])
  pdf.addPage([200, 200])
  writeFileSync(path, await pdf.save())
}

async function externallyInsertPage(path: string): Promise<void> {
  const pdf = await PDFDocument.load(readFileSync(path))
  pdf.insertPage(0, [50, 50])
  writeFileSync(path, await pdf.save())
}

async function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'pdf-source-conflict-'))
  const source = join(tempDir, 'source.pdf')
  const target = join(tempDir, 'copy.pdf')
  await makePdf(source)
  createPdfView(source)
  const displayed = (await invoke(PDF_CHANNELS.readFile, source)) as {
    bytes: ArrayBuffer
    sourceVersion: string
  }
  return { source, target, displayed, wc: lastContents }
}

const saveRequest = (path: string, sourceVersion: string, targetPath?: string) => ({
  path,
  sourceVersion,
  targetPath,
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  rotations: [{ pageIndex: 1, delta: 90 as const }],
})

afterEach(() => {
  showSaveDialog.mockReset()
  lastContents?.listeners.get('destroyed')?.()
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = ''
})

describe('PDF source-version conflicts', () => {
  it('refuses Save after a page insertion without rotating a different page and keeps the external bytes', async () => {
    const { source, displayed } = await setup()
    await externallyInsertPage(source)
    const externalBytes = readFileSync(source)

    expect(await invoke(PDF_CHANNELS.save, saveRequest(source, displayed.sourceVersion))).toEqual({
      ok: false,
      error: expect.stringContaining('changed on disk'),
    })
    expect(readFileSync(source)).toEqual(externalBytes)
    const changed = await PDFDocument.load(readFileSync(source))
    expect(changed.getPageCount()).toBe(3)
    expect(changed.getPages().map((page) => page.getRotation().angle)).toEqual([0, 0, 0])
  })

  it('refuses Save As on a changed source and leaves the pending output unwritten', async () => {
    const { source, target, displayed } = await setup()
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    expect(await invoke(PDF_CHANNELS.pickSavePath, 'copy.pdf')).toBe(target)
    await externallyInsertPage(source)
    const externalBytes = readFileSync(source)

    expect(
      await invoke(PDF_CHANNELS.save, saveRequest(source, displayed.sourceVersion, target)),
    ).toEqual({ ok: false, error: expect.stringContaining('changed on disk') })
    expect(readFileSync(source)).toEqual(externalBytes)
    expect(() => readFileSync(target)).toThrow()
  })

  it('refuses a direct in-place page operation when its displayed source is stale', async () => {
    const { source, displayed } = await setup()
    await externallyInsertPage(source)
    const externalBytes = readFileSync(source)

    expect(
      await invoke(PDF_CHANNELS.insertBlankPage, {
        path: source,
        sourceVersion: displayed.sourceVersion,
        afterPageIndex: 0,
      }),
    ).toEqual({ ok: false, error: expect.stringContaining('changed on disk') })
    expect(readFileSync(source)).toEqual(externalBytes)
    expect((await PDFDocument.load(readFileSync(source))).getPageCount()).toBe(3)
  })

  it('updates the accepted version after a successful app write and reread', async () => {
    const { source, displayed } = await setup()
    expect(await invoke(PDF_CHANNELS.save, saveRequest(source, displayed.sourceVersion))).toEqual({
      ok: true,
    })
    const reread = (await invoke(PDF_CHANNELS.readFile, source)) as {
      bytes: ArrayBuffer
      sourceVersion: string
    }
    expect(reread.sourceVersion).not.toBe(displayed.sourceVersion)
    expect((await PDFDocument.load(reread.bytes)).getPage(1).getRotation().angle).toBe(90)
  })
})
