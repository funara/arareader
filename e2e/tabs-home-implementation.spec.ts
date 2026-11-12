import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

interface ListedTab {
  id: string
  kind: 'home' | 'pdf'
  title: string
  active: boolean
}

interface TabsBridge {
  list(): Promise<ListedTab[]>
}

async function listTabs(page: Page): Promise<ListedTab[]> {
  return page.evaluate(() => (window as unknown as { readerTabs: TabsBridge }).readerTabs.list())
}

async function syntheticPdfBytes(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  return document.save()
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

test('PDF tabs are keyboard-selectable, separately closable, and still reorder by pointer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-tabs-keyboard-'))
  const paths = [join(dir, 'first.pdf'), join(dir, 'second.pdf')]
  const bytes = await syntheticPdfBytes()
  await Promise.all(paths.map((path) => writeFile(path, bytes)))
  const launched = await launchApp()

  try {
    const { page } = launched
    await page.evaluate(async (openPaths) => {
      const reader = (window as unknown as { reader: { openPath(path: string): Promise<void> } })
        .reader
      for (const path of openPaths) await reader.openPath(path)
    }, paths)

    const home = page
      .locator('.tab-home-floating')
      .getByRole('button', { name: 'Home', exact: true })
    const first = page.locator('.tab-strip').getByRole('button', { name: 'first.pdf', exact: true })
    const second = page
      .locator('.tab-strip')
      .getByRole('button', { name: 'second.pdf', exact: true })
    const firstTab = first.locator('xpath=..')
    const secondTab = second.locator('xpath=..')
    await expect(first).toBeVisible()
    await expect(second).toBeVisible()
    await expect(first.locator('button')).toHaveCount(0)
    await expect(firstTab.locator('.tab-close')).toHaveCount(1)
    await expect(home).toHaveAttribute('aria-pressed', 'false')
    await expect(first).toHaveAttribute('aria-pressed', 'false')
    await expect(second).toHaveAttribute('aria-pressed', 'true')

    await home.focus()
    await page.keyboard.press('Tab')
    await expect(first).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expect(second).toHaveAttribute('aria-pressed', 'false')
    await expect
      .poll(async () => (await listTabs(page)).find((tab) => tab.active)?.title)
      .toBe('first.pdf')

    await home.focus()
    await page.keyboard.press('Tab')
    await expect(first).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(firstTab.locator('.tab-close')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(second).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await expect(first).toHaveAttribute('aria-pressed', 'false')
    await expect
      .poll(async () => (await listTabs(page)).find((tab) => tab.active)?.title)
      .toBe('second.pdf')

    await first.click()
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expect(second).toHaveAttribute('aria-pressed', 'false')
    await expect
      .poll(async () => (await listTabs(page)).find((tab) => tab.active)?.title)
      .toBe('first.pdf')

    const firstBox = await firstTab.boundingBox()
    const secondBox = await secondTab.boundingBox()
    expect(firstBox).not.toBeNull()
    expect(secondBox).not.toBeNull()
    await page.mouse.move(secondBox!.x + secondBox!.width / 2, secondBox!.y + 16)
    await page.mouse.down()
    await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + 16, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(async () =>
        (await listTabs(page)).filter((tab) => tab.kind === 'pdf').map((tab) => tab.title),
      )
      .toEqual(['second.pdf', 'first.pdf'])

    await home.focus()
    await page.keyboard.press('Tab')
    const secondClose = secondTab.locator('.tab-close')
    await page.keyboard.press('Tab')
    await expect(secondClose).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(second).toHaveCount(0)
    await expect(first).toBeVisible()
    await expect
      .poll(async () => (await listTabs(page)).filter((tab) => tab.kind === 'pdf').length)
      .toBe(1)
    await firstTab.click({ button: 'middle' })
    await expect(first).toHaveCount(0)
    await expect
      .poll(async () => (await listTabs(page)).filter((tab) => tab.kind === 'pdf').length)
      .toBe(0)
  } finally {
    await closeReader(launched)
    await rm(dir, { recursive: true, force: true })
  }
})

test('keyboard-closing a dirty PDF and cancelling preserves the edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-dirty-tab-close-'))
  const path = join(dir, 'dirty.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([612, 792])
  await writeFile(path, await document.save())

  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-dirty-tab-profile-'))
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
  const launched = await launchApp({ userDataDir })

  try {
    const { page, app } = launched
    await page.evaluate((file) => window.reader.openPath(file), path)
    const pdf = await waitForPageWithUrl(app, 'pdf/out')
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    const original = await digest(path)
    const moveFirstPageToEnd = async () => {
      await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
      await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    }
    await moveFirstPageToEnd()
    await pdf.locator('.qa-btn[aria-label="Save"]').click()
    await expect(pdf.locator('.tb-save-ok')).toBeVisible()
    const lastSaved = await digest(path)
    expect(lastSaved).not.toBe(original)
    await moveFirstPageToEnd()

    await app.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & {
        __closePromptCount?: number
        __resolveClosePrompt?: (result: { response: number; checkboxChecked: boolean }) => void
      }
      state.__closePromptCount = 0
      state.__resolveClosePrompt = undefined
      dialog.showMessageBox = async () =>
        new Promise((resolve) => {
          state.__closePromptCount = (state.__closePromptCount ?? 0) + 1
          state.__resolveClosePrompt = resolve
        })
    })

    const tab = page.locator('.tab-item').filter({
      has: page.getByRole('button', { name: 'dirty.pdf', exact: true }),
    })
    const close = tab.getByRole('button', { name: 'Close tab' })
    await close.focus()
    await page.keyboard.press('Enter')
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __closePromptCount?: number
                __resolveClosePrompt?: (result: {
                  response: number
                  checkboxChecked: boolean
                }) => void
              }
            ).__resolveClosePrompt !== undefined,
        ),
      )
      .toBe(true)

    // Blur while the native confirmation is pending must not let autosave beat a later Cancel.
    await pdf.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect.poll(() => digest(path)).toBe(lastSaved)
    await app.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __resolveClosePrompt?: (result: { response: number; checkboxChecked: boolean }) => void
        }
      ).__resolveClosePrompt?.({ response: 2, checkboxChecked: false }),
    )

    await expect(tab).toBeVisible()
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    expect(await digest(path)).toBe(lastSaved)

    // Leave no dirty tab behind for the test harness's orderly app shutdown.
    await pdf.locator('.qa-btn[aria-label="Save"]').click()
    await expect(pdf.locator('.tb-save-pending')).toHaveCount(0)
  } finally {
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('Dont Save on one tab cannot autosave if a later whole-window close is cancelled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-multitab-discard-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-multitab-discard-profile-'))
  const paths = [join(dir, 'first.pdf'), join(dir, 'second.pdf')]
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([612, 792])
  const bytes = await document.save()
  await Promise.all(paths.map((path) => writeFile(path, bytes)))
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
  const launched = await launchApp({ userDataDir })
  let pdfViews: Page[] = []

  try {
    const { page, app } = launched
    await page.evaluate(async (openPaths) => {
      for (const path of openPaths) await window.reader.openPath(path)
    }, paths)

    const pdfs = () => app.windows().filter((candidate) => candidate.url().includes('pdf/out'))
    await expect.poll(() => pdfs().length).toBe(2)
    pdfViews = pdfs()
    const namedPdfs = await Promise.all(
      pdfViews.map(
        async (candidate) =>
          [(await candidate.locator('.ribbon-file').textContent())?.trim(), candidate] as const,
      ),
    )
    const first = namedPdfs.find(([name]) => name === 'first.pdf')?.[1]
    const second = namedPdfs.find(([name]) => name === 'second.pdf')?.[1]
    if (!first || !second) throw new Error('Both synthetic PDF views should be open.')
    await expect(first.locator('.pdf-thumb')).toHaveCount(2)
    await expect(second.locator('.pdf-thumb')).toHaveCount(2)

    const changeOrder = async (pdf: Page) => {
      await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
      await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
    }
    const saveAndEditAgain = async (pdf: Page) => {
      await changeOrder(pdf)
      await pdf.locator('.qa-btn[aria-label="Save"]').click()
      await expect(pdf.locator('.tb-save-ok')).toBeVisible()
      const path =
        paths[(await pdf.locator('.ribbon-file').textContent())?.trim() === 'first.pdf' ? 0 : 1]!
      const digestAfterSave = await digest(path)
      await changeOrder(pdf)
      return digestAfterSave
    }
    const firstSavedDigest = await saveAndEditAgain(first)
    await saveAndEditAgain(second)

    await app.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & {
        __closePromptCount?: number
        __closePromptResponses?: number[]
      }
      state.__closePromptCount = 0
      state.__closePromptResponses = [1, 2]
      dialog.showMessageBox = async () => {
        state.__closePromptCount = (state.__closePromptCount ?? 0) + 1
        return {
          response: state.__closePromptResponses?.shift() ?? 2,
          checkboxChecked: false,
        }
      }
    })
    await app.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes('desktop/out/renderer'),
      )
      host?.close()
    })
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { __closePromptCount?: number }).__closePromptCount,
        ),
      )
      .toBe(2)
    await expect(page.locator('.tab-strip')).toBeVisible()

    // The first tab's Don't Save choice is retained as a no-autosave decision if
    // the second tab cancels the overall close. A later blur must not write it.
    await first.evaluate(() => window.dispatchEvent(new Event('blur')))
    await first.waitForTimeout(500)
    expect(await digest(paths[0]!)).toBe(firstSavedDigest)
    await expect(first.locator('.tb-save-pending')).toHaveText('Unsaved')

    // Restore both fixtures to a clean state before orderly teardown.
    await first.locator('.qa-btn[aria-label="Save"]').click()
    await expect(first.locator('.tb-save-pending')).toHaveCount(0)
    await second.locator('.qa-btn[aria-label="Save"]').click()
    await expect(second.locator('.tb-save-pending')).toHaveCount(0)
  } finally {
    for (const pdf of pdfViews) {
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

test('Home searches and stars all retained recent PDFs while excluding missing files', async () => {
  const filesDir = await mkdtemp(join(tmpdir(), 'arareader-home-recent-files-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-home-recent-profile-'))
  const paths = Array.from({ length: 51 }, (_, index) =>
    join(filesDir, `recent-${String(index).padStart(2, '0')}.pdf`),
  )
  const bytes = await syntheticPdfBytes()
  await Promise.all(paths.map((path) => writeFile(path, bytes)))
  const missingPath = join(filesDir, 'missing.pdf')
  await writeFile(
    join(userDataDir, 'recent.json'),
    JSON.stringify([missingPath, ...paths.slice().reverse()]),
    'utf8',
  )
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        profile: {
          displayName: 'E2E User',
          fullName: 'E2E Test User',
          title: '',
          organization: '',
          email: '',
          useAsDefaultAuthor: true,
        },
        signatures: [],
        starredPaths: [],
        defaultZoom: 'fit-width',
        defaultSidebar: 'none',
        autosave: false,
      },
    }),
    'utf8',
  )
  const launched = await launchApp({ userDataDir })

  try {
    const { page } = launched
    const rows = page.locator('.recent-list .recent-row')
    await expect(rows).toHaveCount(51)
    await expect(page.locator('.file-count')).toContainText('51')

    const olderPdf = 'recent-00.pdf'
    const olderRow = rows.filter({ hasText: olderPdf })
    await expect(olderRow).toBeVisible()
    const search = page.getByRole('textbox', { name: 'Filter documents' })
    await search.fill(olderPdf)
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(olderPdf)
    await rows.getByRole('button', { name: `Star ${olderPdf}`, exact: true }).click()
    await search.fill('')

    await page.locator('.sidebar-nav .nav-item').nth(1).click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(olderPdf)
    await search.fill(olderPdf)
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(olderPdf)
    await expect(page.locator('.file-count')).toContainText('1')
  } finally {
    await closeReader(launched)
    await Promise.all([
      rm(filesDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})
