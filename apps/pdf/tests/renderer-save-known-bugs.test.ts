// @vitest-environment node
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { PDFDocument, degrees } from 'pdf-lib'
import { expect, it } from 'vitest'
import {
  saveStateAfterFailure,
  trackSaveInFlight,
  type PdfSaveState,
} from '../src/renderer/save-flight'

// The mocked IPC writes real synthetic PDF bytes; this is not an Electron integration test.
async function harness(
  failReload: boolean,
  deferPicker = false,
  hostWarning?: string,
  failWrite = false,
) {
  const pdf = await PDFDocument.create()
  pdf.addPage([100, 100])
  const files = new Map([['A', await pdf.save()]])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let finishPicker!: (path: string | null) => void
  const picker = new Promise<string | null>((resolve) => (finishPicker = resolve))
  let writes = 0
  let failReads = failReload
  let writeFails = failWrite
  let pickerCalls = 0
  const readPaths: string[] = []
  let reconciled = false
  let saveError = ''
  let state: PdfSaveState = 'idle'
  const errors: string[] = []
  const api = {
    save: async (request: {
      path: string
      targetPath?: string
      rotations: { pageIndex: number; delta: number }[]
    }) => {
      if (++writes === 1 && !failReload) await gate
      if (writeFails) return { ok: false, error: 'synthetic write failure' }
      const doc = await PDFDocument.load(files.get(request.path)!)
      for (const r of request.rotations) {
        const page = doc.getPage(r.pageIndex)
        page.setRotation(degrees(page.getRotation().angle + r.delta))
      }
      files.set(request.targetPath ?? request.path, await doc.save())
      return { ok: true, ...(hostWarning ? { warning: hostWarning } : {}) }
    },
    pickSavePath: async () => {
      pickerCalls++
      return deferPicker ? picker : 'B'
    },
    setDirty: () => {},
  }
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('  const reconcileWritten =')
  const end = source.indexOf('  // Autosave (same strategy', start)
  expect(start, 'save callback marker must exist').toBeGreaterThanOrEqual(0)
  expect(end, 'end marker must follow save callbacks').toBeGreaterThan(start)
  const js = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  const ctx = {
    saveInFlightRef: { current: null },
    closePromptActiveRef: { current: false },
    saveAsInFlightRef: { current: null },
    pendingReconcileRef: { current: null },
    setPendingReconcile: () => {},
    editProducersRef: { current: 0 },
    directOperationRef: { current: false },
    externalRefreshRef: { current: false },
    draftPages: new Set(),
    dirty: true,
    saveState: 'idle',
    filePath: 'A',
    fileName: 'A',
    doc: {},
    trackSaveInFlight,
    setSaveState: (update: PdfSaveState | ((state: PdfSaveState) => PdfSaveState)) => {
      state = typeof update === 'function' ? update(state) : update
    },
    lastSaveAtRef: { current: 0 },
    editsPayload: () => ({ rotations: reconciled ? [] : [{ pageIndex: 0, delta: 90 }] }),
    opFailed: (error: string, kind: 'save' | 'operation' = 'operation') => {
      saveError = error
      errors.push(error)
      state = saveStateAfterFailure(state, kind)
    },
    setSaveError: (update: (error: string) => string) => {
      saveError = update(saveError)
    },
    setOrganizeError: () => {},
    savedOnceRef: { current: false },
    dirtyRef: { current: true },
    reloadDoc: async () => {
      if (failReload) throw new Error('synthetic read failure')
      reconciled = true
    },
    loadDoc: async (path: string) => {
      readPaths.push(path)
      if (failReads) throw new Error('synthetic read failure')
      reconciled = true
    },
    setSaveErrorKind: () => {},
    setFilePath: () => {},
    scrollRef: { current: null },
    requestAnimationFrame: () => {},
    window: { pdfApi: api },
    setTimeout: () => 0,
  }
  const actions = new Function(...Object.keys(ctx), `${js}; return {save, saveAs}`)(
    ...Object.values(ctx),
  ) as {
    save: () => Promise<boolean>
    saveAs: () => Promise<boolean>
  }
  const rotation = async (path: string) =>
    (await PDFDocument.load(files.get(path)!)).getPage(0).getRotation().angle
  return {
    ...actions,
    release,
    finishPicker,
    rotation,
    errors,
    saveError: () => saveError,
    state: () => state,
    hasFile: (path: string) => files.has(path),
    writes: () => writes,
    readPaths,
    pickerCalls: () => pickerCalls,
    allowReads: () => {
      failReads = false
    },
    allowWrites: () => {
      writeFails = false
    },
    directOperationRef: ctx.directOperationRef,
    pendingReconcileRef: ctx.pendingReconcileRef as { current: { path: string } | null },
  }
}

it('refuses overlapping Save As with a retry notice rather than repeating a rotation', async () => {
  const h = await harness(false)
  const first = h.save()
  const second = h.saveAs()
  h.release()
  expect((await Promise.all([first, second]))[0]).toBe(true)
  expect(h.writes()).toBe(1)
  expect(await h.rotation('A')).toBe(90)
  expect(h.hasFile('B')).toBe(false)
  expect(h.errors).toContain('Save finished. Please retry Save As.')
  // Model the next render's reconciled payload when the user retries.
  await h.saveAs()
  expect(h.writes()).toBe(2)
  expect(await h.rotation('B')).toBe(90)
})

it('retains a disk error and asks for Save As retry after an overlapping failed Save', async () => {
  const h = await harness(false, false, undefined, true)
  const first = h.save()
  const second = h.saveAs()
  h.release()
  expect(await first).toBe(false)
  await second
  expect(h.writes()).toBe(1)
  expect(await h.rotation('A')).toBe(0)
  expect(h.hasFile('B')).toBe(false)
  expect(h.saveError()).toBe(
    'synthetic write failure Please retry Save As after resolving the Save error.',
  )
})

it('refuses Save during a canceled Save As picker and asks for a retry', async () => {
  const h = await harness(false, true)
  const picking = h.saveAs()
  expect(await h.save()).toBe(false)
  h.finishPicker(null)
  await picking
  await Promise.resolve()
  expect(h.writes()).toBe(0)
  expect(await h.rotation('A')).toBe(0)
  expect(h.hasFile('B')).toBe(false)
  expect(h.errors).toContain('Please retry Save after Save As.')
  h.release()
  expect(await h.save()).toBe(true)
  expect(h.writes()).toBe(1)
  expect(await h.rotation('A')).toBe(90)
})

it('refuses Save during a successful Save As picker instead of writing the old path', async () => {
  const h = await harness(false, true)
  const picking = h.saveAs()
  expect(await h.save()).toBe(false)
  h.release()
  h.finishPicker('B')
  await picking
  await Promise.resolve()
  expect(h.writes()).toBe(1)
  expect(await h.rotation('A')).toBe(0)
  expect(await h.rotation('B')).toBe(90)
  expect(h.errors).toContain('Please retry Save after Save As.')
})

it('preserves a Save As disk failure when an overlapping Save is rejected', async () => {
  const h = await harness(false, true, undefined, true)
  const picking = h.saveAs()
  expect(await h.save()).toBe(false)
  h.release()
  h.finishPicker('B')
  await picking
  await Promise.resolve()
  expect(h.saveError()).toBe('synthetic write failure Please retry Save after Save As.')
  expect(h.state()).toBe('error')
  expect(await h.rotation('A')).toBe(0)
  expect(h.hasFile('B')).toBe(false)
})

it('preserves a Save As host warning when an overlapping Save is rejected', async () => {
  const h = await harness(false, true, 'host hook failed')
  const picking = h.saveAs()
  expect(await h.save()).toBe(false)
  h.release()
  h.finishPicker('B')
  await picking
  await Promise.resolve()
  expect(h.saveError()).toContain('Saved to B, but the host could not finish updating the tab')
  expect(h.saveError()).toContain('Please retry Save after Save As.')
  expect(h.state()).toBe('error')
  expect(await h.rotation('B')).toBe(90)
})

it('reports a host warning after the copy was written rather than treating it as a write failure', async () => {
  const h = await harness(false, false, 'host hook failed')
  h.release()
  await h.saveAs()
  expect(h.writes()).toBe(1)
  expect(await h.rotation('B')).toBe(90)
  expect(h.state()).toBe('error') // warning is visible and the reader is unlocked
  expect(h.errors).toContain(
    'Saved to B, but the host could not finish updating the tab: host hook failed. Reopen the saved copy if the tab is incorrect.',
  )
})

it('does not report success after a reload failure', async () => {
  const h = await harness(true)
  expect(await h.save()).toBe(false)
  expect(await h.rotation('A')).toBe(90)
})

it('does not replay persisted edits when retrying after a reload failure', async () => {
  const h = await harness(true)
  expect(await h.save()).toBe(false)
  expect(await h.save()).toBe(false)
  expect(await h.rotation('A')).toBe(90)
  expect(h.writes()).toBe(1)
  h.allowReads()
  expect(await h.save()).toBe(true)
  expect(await h.rotation('A')).toBe(90)
  expect(h.writes()).toBe(1)
  expect(h.readPaths).toEqual(['A', 'A', 'A'])
})

it('retries refreshing the Save As target without another write or picker', async () => {
  const h = await harness(true)
  expect(await h.saveAs()).toBe(true)
  expect(await h.rotation('B')).toBe(90)
  expect(await h.saveAs()).toBe(true)
  h.allowReads()
  expect(await h.save()).toBe(true)
  expect(h.readPaths).toEqual(['B', 'B', 'B'])
  expect(h.writes()).toBe(1)
  expect(h.pickerCalls()).toBe(1)
})

it('does not start a second refresh while a direct write is refreshing', async () => {
  const h = await harness(true)
  h.directOperationRef.current = true
  h.pendingReconcileRef.current = { path: 'A' }
  expect(await h.save()).toBe(false)
  expect(h.readPaths).toEqual([])
  expect(h.writes()).toBe(0)
})

it('retries an actual write failure rather than treating it as a refresh failure', async () => {
  const h = await harness(false, false, undefined, true)
  h.release()
  expect(await h.save()).toBe(false)
  expect(h.readPaths).toEqual([])
  h.allowWrites()
  expect(await h.save()).toBe(true)
  expect(h.writes()).toBe(2)
  expect(await h.rotation('A')).toBe(90)
})
