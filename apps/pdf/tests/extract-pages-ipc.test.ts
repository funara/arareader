// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const showSaveDialog = vi.hoisted(() => vi.fn())
const faults = vi.hoisted(() => ({ write: false, rename: false }))
let nextId = 1000
let dir = ''

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (faults.write) {
        await actual.writeFile(args[0], 'partial')
        throw new Error('injected partial write failure')
      }
      return actual.writeFile(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename) throw new Error('injected rename failure')
      return actual.rename(...args)
    },
  }
})

vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: vi.fn(() => new Promise(() => {})) },
  dialog: { showSaveDialog },
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
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
}))

import { createPdfView } from '../src/main/pdf-main'
import { PDF_CHANNELS } from '../src/shared/ipc'

async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'pdf-extract-ipc-'))
  const source = join(dir, 'source.pdf')
  const target = join(dir, 'output.pdf')
  const pdf = await PDFDocument.create()
  pdf.addPage([100, 200])
  pdf.addPage([300, 400])
  pdf.addPage([500, 600])
  writeFileSync(source, await pdf.save())
  const original = Buffer.from('existing target bytes')
  writeFileSync(target, original)
  const wc = createPdfView(source).webContents
  showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
  const extract = (path = source) => {
    const handler = handlers.get(PDF_CHANNELS.extractPages)
    if (!handler) throw new Error('Missing extraction handler')
    return handler({ sender: wc }, { path, pages: [2, 0], suggestedName: 'output.pdf' })
  }
  return { source, target, original, extract }
}

afterEach(() => {
  faults.write = false
  faults.rename = false
  showSaveDialog.mockReset()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('extract-pages IPC atomic output', () => {
  it('preserves an existing output on partial write and rename failures, then retries in page order', async () => {
    const { target, original, extract } = await setup()
    faults.write = true
    expect(await extract()).toEqual({ ok: false, error: 'injected partial write failure' })
    expect(readFileSync(target)).toEqual(original)
    expect(readdirSync(dir).sort()).toEqual(['output.pdf', 'source.pdf'])

    faults.write = false
    faults.rename = true
    expect(await extract()).toEqual({ ok: false, error: 'injected rename failure' })
    expect(readFileSync(target)).toEqual(original)
    expect(readdirSync(dir).sort()).toEqual(['output.pdf', 'source.pdf'])

    faults.rename = false
    expect(await extract()).toEqual({ ok: true, savedPath: target })
    const pages = (await PDFDocument.load(readFileSync(target))).getPages()
    expect(pages.map((page) => page.getSize())).toEqual([
      { width: 500, height: 600 },
      { width: 100, height: 200 },
    ])
    expect(readdirSync(dir).sort()).toEqual(['output.pdf', 'source.pdf'])
  })

  it('does not write on cancellation or for an ungranted source', async () => {
    const { target, original, extract } = await setup()
    showSaveDialog.mockResolvedValueOnce({ canceled: true })
    expect(await extract()).toEqual({ ok: true, canceled: true })
    showSaveDialog.mockClear()
    expect(await extract(target)).toEqual({
      ok: false,
      error: 'pdf: path not granted to this view',
    })
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(readFileSync(target)).toEqual(original)
  })
})
