// @vitest-environment node
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'

// Exercise the actual renderer callbacks at their IPC seam without an Electron profile.
function callbacks(context: Record<string, unknown>) {
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('  const flushThen = async')
  const end = source.indexOf('  /**\n   * Insert a blank page', start)
  if (start < 0 || end < 0) throw new Error('Renderer page callbacks not found')
  const javascript = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  return new Function(
    ...Object.keys(context),
    `${javascript}\nreturn { extractPage, confirmExtract, insertPdf }`,
  )(...Object.values(context)) as {
    extractPage: (index: number) => Promise<void>
    confirmExtract: () => void
    insertPdf: (index: number) => Promise<void>
  }
}

async function harness(visList: number[], saved = true) {
  const original = await PDFDocument.create()
  for (const width of [101, 202, 303]) original.addPage([width, 100])
  const initial = await original.save()
  let disk = initial
  let extracted: number[] = []
  const save = vi.fn(async () => {
    if (!saved) return false
    const source = await PDFDocument.load(initial)
    const reordered = await PDFDocument.create()
    for (const page of await reordered.copyPages(source, visList)) reordered.addPage(page)
    disk = await reordered.save()
    return true
  })
  const extractPages = vi.fn(async ({ pages }: { pages: number[] }) => {
    const source = await PDFDocument.load(disk)
    const output = await PDFDocument.create()
    for (const page of await output.copyPages(source, pages)) output.addPage(page)
    extracted = output.getPages().map((page) => page.getWidth())
    return { ok: true }
  })
  const insertPdf = vi.fn(
    async ({
      afterPageIndex,
    }: {
      afterPageIndex: number
    }): Promise<{ ok: true; canceled?: true }> => {
      const source = await PDFDocument.load(disk)
      const output = await PDFDocument.create()
      const pages = await output.copyPages(source, source.getPageIndices())
      pages.splice(afterPageIndex + 1, 0, output.addPage([404, 100]))
      output.removePage(0)
      for (const page of pages) output.addPage(page)
      disk = await output.save()
      return { ok: true }
    },
  )
  const api = { extractPages, insertPdf, setDirty: vi.fn() }
  const loadDoc = vi.fn()
  const pendingReconcileRef: { current: { path: string } | null } = { current: null }
  const closePromptActiveRef = { current: false }
  const editProducersRef = { current: 0 }
  const actions = callbacks({
    dirty: true,
    pendingReconcileRef,
    closePromptActiveRef,
    saveInFlightRef: { current: null },
    saveAsInFlightRef: { current: null },
    directOperationRef: { current: false },
    directInFlightRef: { current: null },
    externalRefreshRef: { current: false },
    editProducersRef,
    dirtyRef: { current: true },
    trackSaveInFlight: <T>(ref: { current: Promise<T> | null }, fn: () => Promise<T>) => {
      const promise = fn().finally(() => {
        ref.current = null
      })
      ref.current = promise
      return promise
    },
    draftPages: new Set(),
    setSaveState: vi.fn(),
    setDirectBusy: vi.fn(),
    setPendingReconcile: vi.fn(),
    reconcileWritten: loadDoc,
    save,
    fileName: 'synthetic.pdf',
    filePath: 'synthetic.pdf',
    visList,
    pageCount: visList.length,
    extractInput: '1',
    parsePageRanges: () => [1],
    currentPage: 1,
    setExtractInput: vi.fn(),
    setExtractInvalid: vi.fn(),
    setExtractDlg: vi.fn(),
    opFailed: vi.fn(),
    doc: {},
    loadDoc,
    window: { pdfApi: api },
  })
  return {
    ...actions,
    save,
    api,
    loadDoc,
    pendingReconcileRef,
    closePromptActiveRef,
    editProducersRef,
    getExtracted: () => extracted,
    getWidths: async () => (await PDFDocument.load(disk)).getPages().map((p) => p.getWidth()),
  }
}

describe('page actions after flushing pending page operations', () => {
  for (const [name, order, expected] of [
    ['reorder', [2, 0, 1], [303, 101, 202]],
    ['deletion', [1, 2], [202, 303]],
  ] as const) {
    it(`extracts the selected thumbnail after ${name}`, async () => {
      const h = await harness([...order])
      await h.extractPage(order[0])
      expect(h.getExtracted()).toEqual([expected[0]])
    })
    it(`extracts displayed page 1 from the dialog after ${name}`, async () => {
      const h = await harness([...order])
      h.confirmExtract()
      await vi.waitFor(() => expect(h.getExtracted()).toEqual([expected[0]]))
    })
    it(`inserts after the selected page after ${name}`, async () => {
      const h = await harness([...order])
      await h.insertPdf(order[0])
      expect(await h.getWidths()).toEqual([expected[0], 404, ...expected.slice(1)])
    })
  }
  it('does not invoke file operations if the flush fails', async () => {
    const h = await harness([2, 0, 1], false)
    await h.extractPage(2)
    await h.insertPdf(2)
    h.confirmExtract()
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(3))
    expect(h.api.extractPages).not.toHaveBeenCalled()
    expect(h.api.insertPdf).not.toHaveBeenCalled()
  })

  it('keeps the front insertion sentinel and does not reload after a canceled picker', async () => {
    const h = await harness([2, 0, 1])
    h.api.insertPdf.mockResolvedValueOnce({ ok: true, canceled: true })
    await h.insertPdf(-1)
    expect(h.api.insertPdf).toHaveBeenCalledWith({ path: 'synthetic.pdf', afterPageIndex: -1 })
    expect(h.loadDoc).not.toHaveBeenCalled()
    expect(await h.getWidths()).toEqual([303, 101, 202])
  })

  it('refuses a second page operation after both awaited the same save', async () => {
    const h = await harness([2, 0, 1])
    let finishSave!: (value: boolean) => void
    let finishInsert!: () => void
    const saveGate = new Promise<boolean>((resolve) => {
      finishSave = resolve
    })
    const insertGate = new Promise<void>((resolve) => {
      finishInsert = resolve
    })
    const originalInsert = h.api.insertPdf.getMockImplementation()!
    h.save.mockImplementation(() => saveGate)
    h.api.insertPdf.mockImplementationOnce(async (request) => {
      await insertGate
      return originalInsert(request)
    })
    const first = h.insertPdf(2)
    const second = h.extractPage(2)
    finishSave(true)
    await vi.waitFor(() => expect(h.api.insertPdf).toHaveBeenCalledOnce())
    await second
    expect(h.api.extractPages).not.toHaveBeenCalled()
    finishInsert()
    await first
  })

  it('pauses a direct operation after the save when close begins, then resumes after cancel', async () => {
    const h = await harness([2, 0, 1])
    let finishSave!: (value: boolean) => void
    h.save.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve
        }),
    )
    const duringClose = h.insertPdf(2)
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce())

    h.closePromptActiveRef.current = true
    finishSave(true)
    await duringClose
    expect(h.api.insertPdf).not.toHaveBeenCalled()

    h.closePromptActiveRef.current = false
    await h.insertPdf(2)
    expect(h.api.insertPdf).toHaveBeenCalledOnce()
  })

  it('does not run a stale page action after pending recovery', async () => {
    const h = await harness([2, 0, 1])
    h.pendingReconcileRef.current = { path: 'synthetic.pdf' }
    await h.extractPage(2)
    expect(h.save).toHaveBeenCalledOnce()
    expect(h.api.extractPages).not.toHaveBeenCalled()
  })

  it('refuses page operations while a producer is active', async () => {
    const h = await harness([2, 0, 1])
    h.editProducersRef.current = 1
    await h.insertPdf(2)
    expect(h.save).not.toHaveBeenCalled()
    expect(h.api.insertPdf).not.toHaveBeenCalled()
  })

  it('rejects a stale selection rather than extracting or inserting at the front', async () => {
    const h = await harness([1, 2])
    await h.extractPage(0)
    await h.insertPdf(0)
    expect(h.save).not.toHaveBeenCalled()
    expect(h.api.extractPages).not.toHaveBeenCalled()
    expect(h.api.insertPdf).not.toHaveBeenCalled()
  })
})
