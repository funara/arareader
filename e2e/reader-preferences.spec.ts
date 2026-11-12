import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import type { PdfApi } from '../apps/pdf/src/shared/ipc'
import { applyOutline } from '../apps/pdf/src/main/outline-writer'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

async function seedUserData(
  preferences: Partial<{
    autosave: boolean
    defaultZoom: 'fit-width' | 'fit-page' | '100' | '125'
    defaultSidebar: 'none' | 'thumbs' | 'outline'
  }> = {},
): Promise<string> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-reader-prefs-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        autosave: false,
        defaultZoom: 'fit-width',
        defaultSidebar: 'thumbs',
        ...preferences,
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
  return userDataDir
}

async function createPdf(path: string, withOutline = true): Promise<void> {
  const document = await PDFDocument.create()
  document.addPage([612, 792]).drawText('First synthetic page', { x: 60, y: 700 })
  document.addPage([612, 792]).drawText('Second synthetic page', { x: 60, y: 700 })
  if (withOutline) applyOutline(document, [{ title: 'Synthetic bookmark', pageIndex: 0 }])
  await writeFile(path, await document.save())
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function openPdf(userDataDir: string, path: string) {
  const launched = await launchApp({ userDataDir, openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  await expect(pdf.locator('.pdf-page').first()).toBeVisible()
  return { ...launched, pdf }
}

test.describe('PDF reader preferences', () => {
  test('applies every default zoom and sidebar value on document open', async () => {
    const cases = [
      { zoom: 'fit-width', sidebar: 'thumbs', outline: true },
      { zoom: 'fit-page', sidebar: 'none', outline: true },
      { zoom: '100', sidebar: 'outline', outline: true },
      { zoom: '125', sidebar: 'outline', outline: true },
    ] as const

    for (const { zoom, sidebar, outline } of cases) {
      const dir = await mkdtemp(join(tmpdir(), 'arareader-reader-view-'))
      const path = join(dir, 'synthetic.pdf')
      await createPdf(path, outline)
      const userDataDir = await seedUserData({
        defaultZoom: zoom,
        defaultSidebar: sidebar,
      })
      const launched = await openPdf(userDataDir, path)
      try {
        const { pdf } = launched
        const zoomValue = pdf.locator('.zoom-value')
        if (zoom === '100' || zoom === '125') {
          await expect(zoomValue).toHaveText(`${zoom}%`)
        } else {
          await expect(zoomValue).toHaveText(/\d+%/)
          const scale = Number((await zoomValue.textContent())?.replace('%', ''))
          expect(scale).toBeGreaterThan(0)
          if (zoom === 'fit-width') expect(scale).toBeGreaterThan(100)
          if (zoom === 'fit-page') expect(scale).toBeLessThan(100)
        }

        if (sidebar === 'none') {
          await expect(pdf.locator('.pdf-sidebar-toggle')).toBeVisible()
          await expect(pdf.locator('.pdf-thumb')).toHaveCount(0)
        } else if (sidebar === 'thumbs') {
          await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
        } else {
          await expect(pdf.locator('.pdf-outline-pane')).toBeVisible()
          await expect(pdf.locator('.pdf-outline-item')).toContainText('Synthetic bookmark')
        }
      } finally {
        await closeReader(launched)
      }
    }
  })

  test('falls back to thumbnails when the default outline panel has no outline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-reader-outline-'))
    const path = join(dir, 'synthetic.pdf')
    await createPdf(path, false)
    const userDataDir = await seedUserData({ defaultSidebar: 'outline' })
    const launched = await openPdf(userDataDir, path)
    try {
      await expect(launched.pdf.locator('.pdf-outline-pane')).toHaveCount(0)
      await expect(launched.pdf.locator('.pdf-thumb')).toHaveCount(2)
    } finally {
      await closeReader(launched)
    }
  })

  test('manual view changes last for the session, and reopening reapplies defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-reader-reopen-'))
    const path = join(dir, 'synthetic.pdf')
    await createPdf(path)
    const userDataDir = await seedUserData({ defaultZoom: '125', defaultSidebar: 'outline' })

    const first = await openPdf(userDataDir, path)
    try {
      await expect(first.pdf.locator('.zoom-value')).toHaveText('125%')
      await expect(first.pdf.locator('.pdf-outline-pane')).toBeVisible()

      await first.pdf.locator('.zoom-btn').first().click()
      await first.pdf.locator('.zoom-btn').first().click()
      await expect(first.pdf.locator('.zoom-value')).toHaveText('100%')
      await first.pdf.locator('.rb-big[title="Thumbnails"]').first().click()
      await expect(first.pdf.locator('.pdf-thumb')).toHaveCount(2)
    } finally {
      await closeReader(first)
    }

    const reopened = await openPdf(userDataDir, path)
    try {
      await expect(reopened.pdf.locator('.zoom-value')).toHaveText('125%')
      await expect(reopened.pdf.locator('.pdf-outline-pane')).toBeVisible()
    } finally {
      await closeReader(reopened)
    }
  })

  test('autosave honors live preference changes and waits for the first explicit save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-reader-autosave-'))
    const path = join(dir, 'synthetic.pdf')
    await createPdf(path)
    const userDataDir = await seedUserData({ autosave: false })
    const launched = await openPdf(userDataDir, path)
    const { pdf } = launched
    try {
      const setAutosave = async (enabled: boolean) =>
        pdf.evaluate(async (value) => {
          const bridge = (window as Window & { pdfApi: PdfApi }).pdfApi
          const preferences = await bridge.getPreferences!()
          await bridge.setPreferences!({ ...preferences, autosave: value })
        }, enabled)
      const triggerBlur = () => pdf.evaluate(() => window.dispatchEvent(new Event('blur')))
      const moveFirstPageToEnd = async () => {
        await pdf.locator('.pdf-thumb').nth(0).dragTo(pdf.locator('.pdf-thumb').nth(1))
        await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')
      }

      // The preference starts off: blur must leave the synthetic file unchanged.
      const original = await digest(path)
      await moveFirstPageToEnd()
      await triggerBlur()
      await expect.poll(() => digest(path)).toBe(original)

      // Turning it on still cannot autosave before this document has a successful manual save.
      await setAutosave(true)
      await triggerBlur()
      await expect.poll(() => digest(path)).toBe(original)

      await pdf.locator('.qa-btn[aria-label="Save"]').click()
      await expect(pdf.locator('.tb-save-ok')).toBeVisible()
      const manuallySaved = await digest(path)
      expect(manuallySaved).not.toBe(original)

      // The preference is live in both directions after the first explicit save.
      await moveFirstPageToEnd()
      await setAutosave(false)
      await triggerBlur()
      await expect.poll(() => digest(path)).toBe(manuallySaved)
      await setAutosave(true)
      await triggerBlur()
      await expect.poll(() => digest(path)).not.toBe(manuallySaved)
      await expect(pdf.locator('.tb-save-ok')).toBeVisible()
    } finally {
      await closeReader(launched)
    }
  })
})
