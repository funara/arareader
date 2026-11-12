// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

/**
 * pdf-main open-path bookkeeping: the renderer calls consume-pending on every
 * mount — including remounts caused by View > Reload (Cmd+R). The path must
 * survive re-consumption or a reload strands the tab on "No file to open".
 */

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const mockShowMessageBox = vi.hoisted(() => vi.fn())
const mockShowSaveDialog = vi.hoisted(() => vi.fn())
const tempDirs: string[] = []

interface FakeWebContents {
  id: number
  once: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  listeners: Map<string, () => void>
  send: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
}

let nextWcId = 1
let lastWebContents: FakeWebContents

function makeFakeWebContents(): FakeWebContents {
  const listeners = new Map<string, () => void>()
  const wc: FakeWebContents = {
    id: nextWcId++,
    listeners,
    once: vi.fn((event: string, handler: () => void) => {
      listeners.set(event, handler)
    }),
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  }
  lastWebContents = wc
  return wc
}

vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: vi.fn(() => new Promise(() => {})) },
  dialog: { showMessageBox: mockShowMessageBox, showSaveDialog: mockShowSaveDialog },
  nativeTheme: { shouldUseDarkColors: true },
  shell: {},
  BrowserWindow: class {
    static fromWebContents = vi.fn(() => null)
    static getFocusedWindow = vi.fn(() => null)
  },
  WebContentsView: class {
    webContents = makeFakeWebContents()
    setBackgroundColor = vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  },
}))

vi.mock('../src/main/save-pdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/save-pdf')>()
  return { ...actual, savePdfToPath: vi.fn(actual.savePdfToPath) }
})

import { PDF_CHANNELS } from '../src/shared/ipc'
import { savePdfToPath } from '../src/main/save-pdf'
import {
  createPdfView,
  requestPdfClose,
  resumePdfClosePrompt,
  setPdfFileSavedHook,
} from '../src/main/pdf-main'

function makePdfFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-open-path-'))
  tempDirs.push(dir)
  const path = join(dir, 'doc.pdf')
  writeFileSync(path, '%PDF-1.4\n%%EOF\n')
  return path
}

const consume = (wcId: number) =>
  handlers.get(PDF_CHANNELS.consumePending)?.({ sender: { id: wcId } })

const invoke = (channel: string, wc: FakeWebContents, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return handler({ sender: wc }, ...args)
}

async function syntheticPdf(): Promise<string> {
  const path = makePdfFile()
  const doc = await PDFDocument.create()
  doc.addPage([300, 400])
  writeFileSync(path, await doc.save())
  return path
}

const saveRequest = (path: string, targetPath?: string) => ({
  path,
  targetPath,
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  rotations: [{ pageIndex: 0, delta: 90 }],
})

afterEach(() => {
  setPdfFileSavedHook(null)
  mockShowSaveDialog.mockReset()
  vi.mocked(savePdfToPath).mockClear()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('pdf open-path lifecycle', () => {
  it('keeps the Save As copy bound on reload and saves that copy without changing the original', async () => {
    const source = await syntheticPdf()
    const original = readFileSync(source)
    const target = join(source, '..', 'copy.pdf')
    createPdfView(source)
    const wc = lastWebContents
    createPdfView(source)
    const other = lastWebContents
    const hook = vi.fn()
    setPdfFileSavedHook(hook)
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    expect(await invoke(PDF_CHANNELS.pickSavePath, wc, 'copy.pdf')).toBe(target)
    expect(await invoke(PDF_CHANNELS.save, other, saveRequest(source, target))).toEqual({
      ok: false,
      error: 'pdf: save target not granted to this view',
    })
    expect(await invoke(PDF_CHANNELS.save, wc, saveRequest(source, target))).toEqual({ ok: true })
    expect(hook).toHaveBeenCalledWith(wc, target)
    expect(consume(wc.id)).toBe(target)
    expect(consume(other.id)).toBe(source)
    const loaded = await invoke(PDF_CHANNELS.readFile, wc, consume(wc.id))
    expect((await PDFDocument.load(loaded as ArrayBuffer)).getPage(0).getRotation().angle).toBe(90)
    expect(await invoke(PDF_CHANNELS.save, wc, saveRequest(target))).toEqual({ ok: true })
    expect((await PDFDocument.load(readFileSync(target))).getPage(0).getRotation().angle).toBe(180)
    expect(readFileSync(source)).toEqual(original)
    wc.listeners.get('destroyed')?.()
    other.listeners.get('destroyed')?.()
  })

  it('leaves the original bound after cancellation, an ungranted target, and a failed write', async () => {
    const source = await syntheticPdf()
    const original = readFileSync(source)
    const target = join(source, '..', 'copy.pdf')
    createPdfView(source)
    const wc = lastWebContents
    mockShowSaveDialog.mockResolvedValueOnce({ canceled: true })
    expect(await invoke(PDF_CHANNELS.pickSavePath, wc, 'copy.pdf')).toBeNull()
    expect(consume(wc.id)).toBe(source)
    expect(await invoke(PDF_CHANNELS.save, wc, saveRequest(source, target))).toEqual({
      ok: false,
      error: 'pdf: save target not granted to this view',
    })
    mockShowSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await invoke(PDF_CHANNELS.pickSavePath, wc, 'copy.pdf')
    vi.mocked(savePdfToPath).mockRejectedValueOnce(new Error('injected save failure'))
    expect(await invoke(PDF_CHANNELS.save, wc, saveRequest(source, target))).toEqual({
      ok: false,
      error: 'injected save failure',
    })
    expect(consume(wc.id)).toBe(source)
    expect(readFileSync(source)).toEqual(original)
    expect(await invoke(PDF_CHANNELS.save, wc, saveRequest(source, target))).toEqual({ ok: true })
    expect(consume(wc.id)).toBe(target)
    expect(readFileSync(source)).toEqual(original)
    wc.listeners.get('destroyed')?.()
  })

  it('does not recreate a destroyed view binding when a delayed Save As completes', async () => {
    const source = await syntheticPdf()
    const target = join(source, '..', 'copy.pdf')
    createPdfView(source)
    const wc = lastWebContents
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    await invoke(PDF_CHANNELS.pickSavePath, wc, 'copy.pdf')
    let finish!: () => void
    vi.mocked(savePdfToPath).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    )
    const saving = invoke(PDF_CHANNELS.save, wc, saveRequest(source, target))
    wc.listeners.get('destroyed')?.()
    finish()
    expect(await saving).toEqual({ ok: true })
    expect(consume(wc.id)).toBeNull()
  })

  it('does not recreate a path grant when a Save As picker finishes after view destruction', async () => {
    const source = await syntheticPdf()
    const target = join(source, '..', 'copy.pdf')
    createPdfView(source)
    const wc = lastWebContents
    let finish!: (result: { canceled: boolean; filePath: string }) => void
    mockShowSaveDialog.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const picking = invoke(PDF_CHANNELS.pickSavePath, wc, 'copy.pdf')
    wc.isDestroyed.mockReturnValue(true)
    wc.listeners.get('destroyed')?.()
    finish({ canceled: false, filePath: target })
    expect(await picking).toBeNull()
    await expect(invoke(PDF_CHANNELS.readFile, wc, target)).rejects.toThrow(
      'pdf: path not granted to this view',
    )
    expect(consume(wc.id)).toBeNull()
  })

  it('reports a post-write host hook failure separately from a failed PDF write', async () => {
    const source = await syntheticPdf()
    const target = join(source, '..', 'copy.pdf')
    createPdfView(source)
    const wc = lastWebContents
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    await invoke(PDF_CHANNELS.pickSavePath, wc, 'copy.pdf')
    setPdfFileSavedHook(() => {
      throw new Error('host hook failed')
    })
    expect(await invoke(PDF_CHANNELS.save, wc, saveRequest(source, target))).toEqual({
      ok: true,
      warning: 'host hook failed',
    })
    expect((await PDFDocument.load(readFileSync(target))).getPage(0).getRotation().angle).toBe(90)
    expect(consume(wc.id)).toBe(target)
    wc.listeners.get('destroyed')?.()
  })

  it('consume-pending returns the path again after a reload (second consume)', () => {
    const path = makePdfFile()
    createPdfView(path)
    const wcId = lastWebContents.id

    expect(consume(wcId)).toBe(path)
    // View > Reload remounts the renderer, which consumes again
    expect(consume(wcId)).toBe(path)
  })

  it('drops the path when the view is destroyed', () => {
    const path = makePdfFile()
    createPdfView(path)
    const wc = lastWebContents

    expect(consume(wc.id)).toBe(path)
    wc.listeners.get('destroyed')?.()
    expect(consume(wc.id)).toBeNull()
  })

  it('waits for a clean mounted view to finish work before deciding whether to close', async () => {
    createPdfView()
    const wc = lastWebContents
    handlers.get(PDF_CHANNELS.dirtyChanged)?.({ sender: { id: wc.id } }, false)
    mockShowMessageBox.mockReset()
    const closing = requestPdfClose(wc as never)
    expect(wc.send).toHaveBeenCalledWith(PDF_CHANNELS.closePromptChanged, true)
    let settled = false
    void closing.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    handlers.get(PDF_CHANNELS.closePromptReady)?.({ sender: { id: wc.id } })
    await expect(closing).resolves.toEqual({ approved: true, discarded: false })
    expect(mockShowMessageBox).not.toHaveBeenCalled()
  })

  it('waits for in-flight autosave quiescence and resumes after close Cancel', async () => {
    createPdfView()
    const wc = lastWebContents
    handlers.get(PDF_CHANNELS.dirtyChanged)?.({ sender: { id: wc.id } }, true)
    mockShowMessageBox.mockReset()
    mockShowMessageBox.mockResolvedValue({ response: 2, checkboxChecked: false })

    const closing = requestPdfClose(wc as never)
    expect(wc.send).toHaveBeenCalledWith(PDF_CHANNELS.closePromptChanged, true)
    expect(mockShowMessageBox).not.toHaveBeenCalled()

    handlers.get(PDF_CHANNELS.closePromptReady)?.({ sender: { id: wc.id } })
    await expect(closing).resolves.toEqual({ approved: false, discarded: false })
    expect(mockShowMessageBox).toHaveBeenCalledOnce()
    expect(wc.send).toHaveBeenLastCalledWith(PDF_CHANNELS.closePromptChanged, false, false)
  })

  it('keeps autosave paused after Dont Save until the caller releases a cancelled window close', async () => {
    createPdfView()
    const wc = lastWebContents
    handlers.get(PDF_CHANNELS.dirtyChanged)?.({ sender: { id: wc.id } }, true)
    mockShowMessageBox.mockReset()
    mockShowMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })

    const closing = requestPdfClose(wc as never)
    handlers.get(PDF_CHANNELS.closePromptReady)?.({ sender: { id: wc.id } })
    await expect(closing).resolves.toEqual({ approved: true, discarded: true })
    expect(wc.send).not.toHaveBeenCalledWith(PDF_CHANNELS.closePromptChanged, false, false)

    resumePdfClosePrompt(wc as never, true)
    expect(wc.send).toHaveBeenLastCalledWith(PDF_CHANNELS.closePromptChanged, false, true)
  })
})
