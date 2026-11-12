import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

test('the reader locks editing controls while a save can still reload pending edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-reader-save-lock-'))
  const path = join(dir, 'synthetic.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([612, 792])
  await writeFile(path, await document.save())

  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-reader-save-lock-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        autosave: false,
        defaultZoom: 'fit-width',
        defaultSidebar: 'thumbs',
      },
    }),
    'utf8',
  )
  const launched = await launchApp({ userDataDir, openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')

  try {
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    await pdf.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.app')
      if (!root) throw new Error('PDF reader root was not rendered.')
      const state = globalThis as typeof globalThis & { __saveLockObserved?: boolean }
      state.__saveLockObserved = root.inert
      const observer = new MutationObserver(() => {
        if (!root.inert) return
        state.__saveLockObserved = true
        observer.disconnect()
      })
      observer.observe(root, { attributes: true, attributeFilter: ['inert'] })
    })

    await pdf.locator('.qa-btn[aria-label="Save"]').click()
    await expect(pdf.locator('.tb-save-ok')).toBeVisible()
    expect(
      await pdf.evaluate(
        () =>
          (globalThis as typeof globalThis & { __saveLockObserved?: boolean }).__saveLockObserved,
      ),
    ).toBe(true)
    await expect(pdf.locator('.app')).toHaveAttribute('aria-busy', 'false')
  } finally {
    await pdf
      .locator('.qa-btn[aria-label="Save"]')
      .click({ timeout: 2_000 })
      .catch(() => {})
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('a successful write with a failed refresh retries only the refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-refresh-recovery-'))
  const path = join(dir, 'synthetic.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([420, 420])
  await writeFile(path, await document.save())
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-refresh-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        autosave: false,
        defaultZoom: 'fit-width',
        defaultSidebar: 'thumbs',
      },
    }),
  )
  const launched = await launchApp({ userDataDir, openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  try {
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    await launched.app.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers
      const read = handlers.get('pdf:read-file')!
      const save = handlers.get('pdf:save')!
      let failNextRead = true
      const state = globalThis as typeof globalThis & { __saveWrites?: number }
      state.__saveWrites = 0
      handlers.set('pdf:read-file', (...args) => {
        if (failNextRead) {
          failNextRead = false
          throw new Error('synthetic post-write refresh failure')
        }
        return read(...args)
      })
      handlers.set('pdf:save', (...args) => {
        state.__saveWrites = (state.__saveWrites ?? 0) + 1
        return save(...args)
      })
    })
    await pdf.locator('.qa-btn[aria-label="Save"]').click()
    const recovery = pdf.locator('.reader-recovery[role="alert"]')
    await expect(recovery).toBeVisible()
    await expect(pdf.locator('.app')).toHaveAttribute('inert', '')
    expect(
      (await PDFDocument.load(await readFile(path))).getPages().map((page) => page.getWidth()),
    ).toEqual([420, 612])
    await recovery.getByRole('button', { name: 'Retry refresh' }).click()
    await expect(recovery).toHaveCount(0)
    await expect(pdf.locator('.app')).not.toHaveAttribute('inert', '')
    expect(
      await launched.app.evaluate(
        () => (globalThis as typeof globalThis & { __saveWrites?: number }).__saveWrites,
      ),
    ).toBe(1)
    expect(
      (await PDFDocument.load(await readFile(path))).getPages().map((page) => page.getWidth()),
    ).toEqual([420, 612])
  } finally {
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('a deferred external refresh rejects a late image edit and stays locked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-external-refresh-'))
  const path = join(dir, 'source.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  await writeFile(path, await document.save())
  const original = await digest(path)
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-external-refresh-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: { onboardingCompleted: true, autosave: false, defaultSidebar: 'thumbs' },
    }),
  )
  const launched = await launchApp({ userDataDir, openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  try {
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(1)
    await launched.app.evaluate(({ ipcMain, webContents }, source) => {
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers
      const read = handlers.get('pdf:read-file')!
      const state = globalThis as typeof globalThis & {
        __refreshEntered?: boolean
        __releaseRefresh?: () => void
      }
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      state.__releaseRefresh = release
      handlers.set('pdf:read-file', async (...args) => {
        state.__refreshEntered = true
        await gate
        return read(...args)
      })
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().includes('pdf/out'))
      if (!view) throw new Error('PDF view not found')
      view.send('pdf:file-changed', source)
    }, path)
    await expect
      .poll(() =>
        launched.app.evaluate(() =>
          Boolean(
            (globalThis as typeof globalThis & { __refreshEntered?: boolean }).__refreshEntered,
          ),
        ),
      )
      .toBe(true)
    await expect(pdf.locator('.app')).toHaveAttribute('inert', '')
    await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await pdf
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'synthetic.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      })
    await expect(pdf.locator('.app')).toHaveAttribute('inert', '')
    await launched.app.evaluate(() =>
      (globalThis as typeof globalThis & { __releaseRefresh?: () => void }).__releaseRefresh?.(),
    )
    await expect(pdf.locator('.app')).not.toHaveAttribute('inert', '')
    await expect(pdf.locator('.reader-error-alert')).toContainText('Please retry adding the image')
    await expect(pdf.locator('.pdf-draw-shape')).toHaveCount(0)
    expect(await digest(path)).toBe(original)
  } finally {
    await launched.app
      .evaluate(() =>
        (globalThis as typeof globalThis & { __releaseRefresh?: () => void }).__releaseRefresh?.(),
      )
      .catch(() => {})
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('Save refuses a pending image decode and keeps the completed edit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-image-save-'))
  const path = join(dir, 'source.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([420, 420])
  await writeFile(path, await document.save())
  const originalDigest = await digest(path)
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-image-save-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        autosave: false,
        defaultZoom: 'fit-width',
        defaultSidebar: 'thumbs',
      },
    }),
  )
  const launched = await launchApp({ userDataDir, openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  try {
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    await pdf.evaluate(() => {
      const OriginalImage = window.Image
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
      window.Image = function (width?: number, height?: number) {
        const image = new OriginalImage(width, height)
        Object.defineProperty(image, 'src', {
          set(value: string) {
            ;(globalThis as typeof globalThis & { __releaseImage?: () => void }).__releaseImage =
              () => descriptor.set!.call(image, value)
          },
          get() {
            return descriptor.get!.call(image)
          },
        })
        return image
      } as typeof Image
    })
    await pdf
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'synthetic.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      })
    await expect
      .poll(() =>
        pdf.evaluate(
          () =>
            typeof (globalThis as typeof globalThis & { __releaseImage?: () => void })
              .__releaseImage,
        ),
      )
      .toBe('function')
    await pdf.locator('.qa-btn[aria-label="Save"]').click()
    await expect(pdf.locator('.reader-error-alert')).toContainText(
      'edit or file operation is still in progress',
    )
    expect(await digest(path)).toBe(originalDigest)
    await pdf.evaluate(() =>
      (globalThis as typeof globalThis & { __releaseImage?: () => void }).__releaseImage?.(),
    )
    await expect(pdf.locator('.pdf-draw-shape')).toHaveCount(1)
    await pdf.locator('.qa-btn[aria-label="Save"]').click()
    await expect(pdf.locator('.tb-save-ok')).toBeVisible()
    const saved = await PDFDocument.load(await readFile(path))
    expect(saved.getPages().map((page) => page.getWidth())).toEqual([420, 612])
    expect(saved.getPage(0).node.Annots()?.size()).toBe(1)
  } finally {
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('host menu overlap and Save As view reload preserve the source and save the copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-menu-save-as-'))
  const source = join(dir, 'source.pdf')
  const target = join(dir, 'copy.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([420, 420])
  await writeFile(source, await document.save())
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-menu-save-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        autosave: false,
        defaultZoom: 'fit-width',
        defaultSidebar: 'thumbs',
      },
    }),
  )
  const launched = await launchApp({ userDataDir, openFile: source })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  try {
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    await launched.app.evaluate(({ ipcMain, dialog }, output) => {
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers
      const original = handlers.get('pdf:save')!
      const state = globalThis as typeof globalThis & {
        __saveEntered?: boolean
        __releaseSave?: () => void
        __pickCount?: number
      }
      state.__pickCount = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      state.__releaseSave = release
      handlers.set('pdf:save', async (...args) => {
        if (!state.__saveEntered) {
          state.__saveEntered = true
          await gate
        }
        return original(...args)
      })
      dialog.showSaveDialog = async () => {
        state.__pickCount = (state.__pickCount ?? 0) + 1
        return { canceled: false, filePath: output }
      }
    }, target)
    const invokeMenu = async (label: string) =>
      launched.app.evaluate(({ Menu }, name) => {
        const file = Menu.getApplicationMenu()?.items.find((item) => item.label === 'File')
        const item = file?.submenu?.items.find((entry) => entry.label === name)
        if (!item?.click) throw new Error(`Missing menu item: ${name}`)
        Reflect.apply(item.click, item, [item, undefined, {}])
      }, label)
    await invokeMenu('Save')
    await expect
      .poll(() =>
        launched.app.evaluate(() =>
          Boolean((globalThis as typeof globalThis & { __saveEntered?: boolean }).__saveEntered),
        ),
      )
      .toBe(true)
    await invokeMenu('Save As…')
    await launched.app.evaluate(() =>
      (globalThis as typeof globalThis & { __releaseSave?: () => void }).__releaseSave?.(),
    )
    await expect(pdf.locator('.reader-error-alert')).toContainText('Please retry Save As')
    expect(
      await launched.app.evaluate(
        () => (globalThis as typeof globalThis & { __pickCount?: number }).__pickCount,
      ),
    ).toBe(0)
    const sourceAfterSave = await digest(source)
    await invokeMenu('Save As…')
    await expect
      .poll(async () => {
        try {
          return (await PDFDocument.load(await readFile(target)))
            .getPages()
            .map((page) => page.getWidth())
        } catch {
          return []
        }
      })
      .toEqual([420, 612])
    await expect(pdf.locator('.app')).toHaveAttribute('aria-busy', 'false')
    await pdf.reload()
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    await invokeMenu('Save')
    await expect
      .poll(async () =>
        (await PDFDocument.load(await readFile(target))).getPages().map((page) => page.getWidth()),
      )
      .toEqual([612, 420])
    expect(await digest(source)).toBe(sourceAfterSave)
  } finally {
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('a close pause cancels a page operation waiting on a deferred save and resumes after cancel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-close-save-race-'))
  const path = join(dir, 'source.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([420, 420])
  await writeFile(path, await document.save())
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-close-save-race-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: { onboardingCompleted: true, autosave: false, defaultSidebar: 'thumbs' },
    }),
  )
  const launched = await launchApp({ userDataDir, openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  let closeRequest: Promise<void> | undefined

  try {
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    await pdf.evaluate(() => {
      const state = globalThis as typeof globalThis & { __closeEvents?: boolean[] }
      state.__closeEvents = []
      window.pdfApi.onClosePromptChanged((active) => state.__closeEvents?.push(active))
    })
    await launched.app.evaluate(({ dialog, ipcMain }) => {
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers
      const save = handlers.get('pdf:save')!
      const insert = handlers.get('pdf:insert-pdf')!
      let releaseSave!: () => void
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve
      })
      const state = globalThis as typeof globalThis & {
        __saveEntered?: boolean
        __releaseSave?: () => void
        __insertCalls?: number
        __pickerCalls?: number
        __closePromptCount?: number
        __releaseClosePrompt?: (result: { response: number; checkboxChecked: boolean }) => void
        __holdDirty?: boolean
      }
      state.__saveEntered = false
      state.__releaseSave = releaseSave
      state.__insertCalls = 0
      state.__pickerCalls = 0
      state.__closePromptCount = 0
      state.__holdDirty = true
      handlers.set('pdf:save', async (...args) => {
        state.__saveEntered = true
        await saveGate
        return save(...args)
      })
      handlers.set('pdf:insert-pdf', (...args) => {
        state.__insertCalls = (state.__insertCalls ?? 0) + 1
        return insert(...args)
      })
      dialog.showOpenDialog = async () => {
        state.__pickerCalls = (state.__pickerCalls ?? 0) + 1
        return { canceled: true, filePaths: [] }
      }
      dialog.showMessageBox = async () =>
        new Promise((resolve) => {
          state.__closePromptCount = (state.__closePromptCount ?? 0) + 1
          state.__releaseClosePrompt = resolve
        })
      // Keep the host close guard dirty after reconciliation so the real close prompt can be canceled.
      ipcMain.on('pdf:dirty-changed', (event, dirty) => {
        if (state.__holdDirty && dirty === false) {
          ipcMain.emit('pdf:dirty-changed', event, true)
        }
      })
    })

    await pdf.locator('.pdf-thumb').first().click({ button: 'right' })
    await pdf.getByRole('button', { name: 'Insert PDF…', exact: true }).click()
    await expect
      .poll(() =>
        launched.app.evaluate(
          () => (globalThis as typeof globalThis & { __saveEntered?: boolean }).__saveEntered,
        ),
      )
      .toBe(true)

    const tabId = await launched.page.evaluate(
      async () => (await window.readerTabs.list()).find((tab) => tab.kind === 'pdf')!.id,
    )
    closeRequest = launched.page.evaluate((id) => window.readerTabs.close(id), tabId)
    await expect
      .poll(() =>
        pdf.evaluate(() =>
          (globalThis as typeof globalThis & { __closeEvents?: boolean[] }).__closeEvents?.includes(
            true,
          ),
        ),
      )
      .toBe(true)
    await expect
      .poll(() =>
        launched.app.evaluate(
          () =>
            (globalThis as typeof globalThis & { __closePromptCount?: number }).__closePromptCount,
        ),
      )
      .toBe(0)

    await launched.app.evaluate(() =>
      (globalThis as typeof globalThis & { __releaseSave?: () => void }).__releaseSave?.(),
    )
    await expect
      .poll(() =>
        launched.app.evaluate(
          () =>
            (globalThis as typeof globalThis & { __closePromptCount?: number }).__closePromptCount,
        ),
      )
      .toBe(1)
    expect(
      await launched.app.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __insertCalls?: number
          __pickerCalls?: number
        }
        return { insertCalls: state.__insertCalls, pickerCalls: state.__pickerCalls }
      }),
    ).toEqual({ insertCalls: 0, pickerCalls: 0 })
    expect(
      (await PDFDocument.load(await readFile(path))).getPages().map((page) => page.getWidth()),
    ).toEqual([420, 612])

    await launched.app.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __releaseClosePrompt?: (result: { response: number; checkboxChecked: boolean }) => void
        }
      ).__releaseClosePrompt?.({ response: 2, checkboxChecked: false }),
    )
    await closeRequest
    await expect
      .poll(() =>
        pdf.evaluate(() =>
          (globalThis as typeof globalThis & { __closeEvents?: boolean[] }).__closeEvents?.at(-1),
        ),
      )
      .toBe(false)
    expect(
      await launched.page.evaluate(
        async () => (await window.readerTabs.list()).filter((tab) => tab.kind === 'pdf').length,
      ),
    ).toBe(1)

    await launched.app.evaluate(() => {
      ;(globalThis as typeof globalThis & { __holdDirty?: boolean }).__holdDirty = false
    })
    await pdf.evaluate(() => window.pdfApi.setDirty(false))
    await pdf.locator('.pdf-thumb').first().click({ button: 'right' })
    await pdf.getByRole('button', { name: 'Insert PDF…', exact: true }).click()
    await expect
      .poll(() =>
        launched.app.evaluate(
          () => (globalThis as typeof globalThis & { __insertCalls?: number }).__insertCalls,
        ),
      )
      .toBe(1)
    await expect
      .poll(() =>
        launched.app.evaluate(
          () => (globalThis as typeof globalThis & { __pickerCalls?: number }).__pickerCalls,
        ),
      )
      .toBe(1)
  } finally {
    await launched.app
      .evaluate(() => {
        const state = globalThis as typeof globalThis & {
          __holdDirty?: boolean
          __releaseSave?: () => void
          __releaseClosePrompt?: (result: { response: number; checkboxChecked: boolean }) => void
        }
        state.__holdDirty = false
        state.__releaseSave?.()
        state.__releaseClosePrompt?.({ response: 2, checkboxChecked: false })
      })
      .catch(() => {})
    await closeRequest?.catch(() => {})
    await pdf.evaluate(() => window.pdfApi.setDirty(false)).catch(() => {})
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('closing a clean tab waits for its pending Save As picker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-close-picker-'))
  const path = join(dir, 'source.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  await writeFile(path, await document.save())
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-close-picker-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: { onboardingCompleted: true, autosave: false, defaultSidebar: 'thumbs' },
    }),
  )
  const launched = await launchApp({ userDataDir, openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  try {
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(1)
    await launched.app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = () =>
        new Promise((resolve) => {
          ;(globalThis as typeof globalThis & { __cancelPicker?: () => void }).__cancelPicker =
            () => resolve({ canceled: true, filePath: undefined })
        })
    })
    await launched.app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.find((entry) => entry.label === 'File')
        ?.submenu?.items.find((entry) => entry.label === 'Save As…')
      if (!item?.click) throw new Error('Missing Save As menu')
      Reflect.apply(item.click, item, [item, undefined, {}])
    })
    await expect
      .poll(() =>
        launched.app.evaluate(
          () =>
            typeof (globalThis as typeof globalThis & { __cancelPicker?: () => void })
              .__cancelPicker,
        ),
      )
      .toBe('function')
    await pdf.evaluate(() => {
      window.pdfApi.onClosePromptChanged((active) => {
        ;(globalThis as typeof globalThis & { __closeObserved?: boolean }).__closeObserved = active
      })
    })
    const id = await launched.page.evaluate(
      async () => (await window.readerTabs.list()).find((tab) => tab.kind === 'pdf')!.id,
    )
    await launched.page.evaluate((tabId) => {
      void window.readerTabs.close(tabId)
    }, id)
    await expect
      .poll(() =>
        pdf.evaluate(
          () => (globalThis as typeof globalThis & { __closeObserved?: boolean }).__closeObserved,
        ),
      )
      .toBe(true)
    expect(
      await launched.page.evaluate(
        async () => (await window.readerTabs.list()).filter((tab) => tab.kind === 'pdf').length,
      ),
    ).toBe(1)
    await launched.app.evaluate(() =>
      (globalThis as typeof globalThis & { __cancelPicker?: () => void }).__cancelPicker?.(),
    )
    await expect
      .poll(() =>
        launched.page.evaluate(
          async () => (await window.readerTabs.list()).filter((tab) => tab.kind === 'pdf').length,
        ),
      )
      .toBe(0)
  } finally {
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('a host notification failure keeps the written Save As target bound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-host-warning-'))
  const source = join(dir, 'source.pdf')
  const target = join(dir, 'copy.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([420, 420])
  await writeFile(source, await document.save())
  const original = await digest(source)
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-host-warning-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: { onboardingCompleted: true, autosave: false, defaultSidebar: 'thumbs' },
    }),
  )
  const launched = await launchApp({ userDataDir, openFile: source })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  try {
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    await launched.app.evaluate(({ dialog, BrowserWindow }, output) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output })
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      const send = contents.send.bind(contents)
      let fail = true
      contents.send = (channel, ...args) => {
        if (channel === 'tabs:changed' && fail) {
          fail = false
          throw new Error('synthetic tab notification failure')
        }
        send(channel, ...args)
      }
    }, target)
    await launched.app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.find((entry) => entry.label === 'File')
        ?.submenu?.items.find((entry) => entry.label === 'Save As…')
      if (!item?.click) throw new Error('Missing Save As menu')
      Reflect.apply(item.click, item, [item, undefined, {}])
    })
    await expect(pdf.locator('.reader-error-alert')).toContainText(
      'synthetic tab notification failure',
    )
    await expect(pdf.locator('.app')).toHaveAttribute('aria-busy', 'false')
    const titles = await launched.page.evaluate(async () =>
      (await window.readerTabs.list()).filter((tab) => tab.kind === 'pdf').map((tab) => tab.title),
    )
    expect(titles).toEqual(['copy.pdf'])
    await pdf.reload()
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
    await pdf.locator('.qa-btn[aria-label="Save"]').click()
    await expect(pdf.locator('.tb-save-ok')).toBeVisible()
    expect(
      (await PDFDocument.load(await readFile(target))).getPages().map((page) => page.getWidth()),
    ).toEqual([420, 612])
    expect(await digest(source)).toBe(original)
  } finally {
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('a non-save failure on a dirty PDF is not reported as a save failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-reader-operation-error-'))
  const path = join(dir, 'synthetic.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([612, 792])
  const bytes = await document.save()
  await writeFile(path, bytes)
  const originalDigest = createHash('sha256').update(bytes).digest('hex')
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-reader-operation-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        autosave: false,
        defaultZoom: 'fit-width',
        defaultSidebar: 'thumbs',
        profile: {
          displayName: 'E2E User',
          fullName: 'E2E Test User',
          title: '',
          organization: '',
          email: '',
          useAsDefaultAuthor: true,
        },
      },
    }),
    'utf8',
  )
  const launched = await launchApp({ userDataDir, openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  let explicitlySaved = false

  try {
    await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    await pdf
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'invalid.png',
        mimeType: 'image/png',
        buffer: Buffer.from('not an image'),
      })

    const alert = pdf.getByRole('alert')
    const message = alert.locator('span')
    await expect(message).toContainText('could not decode image')
    await expect(message).not.toContainText('Save failed')
    await expect(message).not.toHaveText('')
    await expect(pdf.locator('.tb-operation-error')).toBeVisible()
    await expect(pdf.locator('.tb-save-error')).toHaveCount(0)
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    await expect(alert.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await expect(alert.getByRole('button', { name: 'Save As…' })).toHaveCount(0)
    expect(await digest(path)).toBe(originalDigest)

    // The toolbar Save remains available and proves the page-order edit was retained.
    await pdf.locator('.qa-btn[aria-label="Save"]').click()
    await expect(pdf.locator('.tb-save-ok')).toBeVisible()
    expect(await digest(path)).not.toBe(originalDigest)
    explicitlySaved = true
  } finally {
    // Keep failure diagnostics useful without leaving a dirty tab to block the test app's close.
    if (!explicitlySaved) {
      await pdf
        .locator('.qa-btn[aria-label="Save"]')
        .click({ timeout: 2_000 })
        .catch(() => {})
    }
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('a failed first save keeps edits, reports the reason, and can be retried', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-reader-save-recovery-'))
  const path = join(dir, 'synthetic.pdf')
  const backupPath = join(dir, 'synthetic-original.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792]).drawText('First page', { x: 60, y: 700 })
  document.addPage([612, 792]).drawText('Second page', { x: 60, y: 700 })
  const originalBytes = await document.save()
  const originalDigest = createHash('sha256').update(originalBytes).digest('hex')
  await writeFile(path, originalBytes)

  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-reader-save-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        autosave: true,
        defaultZoom: 'fit-width',
        defaultSidebar: 'thumbs',
        profile: {
          displayName: 'E2E User',
          fullName: 'E2E Test User',
          title: '',
          organization: '',
          email: '',
          useAsDefaultAuthor: true,
        },
      },
    }),
    'utf8',
  )

  const launched = await launchApp({ userDataDir, openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  let movedOriginal = false
  try {
    await expect(pdf.locator('.pdf-page').first()).toBeVisible()
    await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')

    // Force a deterministic source-read failure after the view has been granted this synthetic
    // PDF path. A directory cannot be read as the PDF source; restore the file before retrying.
    await rename(path, backupPath)
    movedOriginal = true
    await mkdir(path)
    await pdf.locator('.qa-btn[aria-label="Save"]').click()

    const alert = pdf.getByRole('alert')
    await expect(alert.locator('span')).toHaveText(/^Save failed: .+/)
    await expect(alert.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
    await expect(alert.getByRole('button', { name: 'Save As…' })).toBeVisible()

    await rm(path, { recursive: true, force: true })
    await rename(backupPath, path)
    movedOriginal = false

    // Failed first save is not consent to autosave: blur must not retry it unattended.
    await pdf.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect.poll(() => digest(path)).toBe(originalDigest)
    await expect(alert).toBeVisible()

    await alert.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(alert).toHaveCount(0)
    await expect(pdf.locator('.tb-save-ok')).toBeVisible()
    expect(await digest(path)).not.toBe(originalDigest)
  } finally {
    if (movedOriginal) {
      await rm(path, { recursive: true, force: true }).catch(() => {})
      await rename(backupPath, path).catch(() => {})
    }
    await closeReader(launched)
  }
})
