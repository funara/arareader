import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  StandardFonts,
} from 'pdf-lib'
import { applyOutline } from '../apps/pdf/src/main/outline-writer'
import { closeReader, launchApp, screenshotPath, waitForPageWithUrl } from './helpers'

/**
 * The top-level bookmark titles stored in the file, walked through /Outlines the
 * same way a viewer does. This is what proves the round trip reached disk rather
 * than only the open view.
 */
async function outlineTitlesOnDisk(path: string): Promise<string[]> {
  const doc = await PDFDocument.load(await readFile(path), { updateMetadata: false })
  const root = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)
  if (!root) return []
  const titles: string[] = []
  let ref = root.get(PDFName.of('First'))
  for (let guard = 0; guard < 64 && ref instanceof PDFRef; guard++) {
    const dict = doc.context.lookup(ref, PDFDict)
    titles.push(dict.lookup(PDFName.of('Title'), PDFHexString).decodeText())
    ref = dict.get(PDFName.of('Next'))
  }
  return titles
}

async function fileDigest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/**
 * Real-app smoke of the PDF features: everything that unit tests cannot cover,
 * because none of it has an Electron runtime. The outline round trip is the
 * most valuable leg — the panel edit goes through the real tab state, the real
 * IPC grant, the real file rewrite and the reload — none of which is reachable
 * from a vitest sandbox.
 *
 * Deliberately out of scope: actions that pop a native folder/save dialog
 * (combine, embedded images on a document that has them, export text/pages) —
 * a modal native dialog would wedge the driver; their wiring is exercised only
 * up to the click. The no-image document below fails before the picker.
 */

test.describe('pdf features', () => {
  test('outline editor round trip rewrites the file and re-renders the sidebar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-pdf-'))
    const path = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    document.addPage([612, 792])
    document.addPage([612, 792])
    applyOutline(document, [
      { title: 'Alpha', pageIndex: 0 },
      { title: 'Beta', pageIndex: 1 },
    ])
    await writeFile(path, await document.save())

    const launched = await launchApp({ openFile: path })
    const { app, page } = launched
    // Uncaught renderer/cross-realm exceptions are the smoke signal that matters:
    // everything else either works visibly or fails visibly in a dialog
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))

    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      pdf.on('pageerror', (error) => crashes.push(String(error)))
      await expect(pdf.locator('.ribbon')).toBeVisible()

      // Open the bookmarks sidebar and enter edit mode
      await pdf.locator('.rb-big[title="Outline"]').first().click()
      const pane = pdf.locator('.pdf-outline-pane')
      await expect(pane.locator('.pdf-outline-toolbar')).toBeVisible()
      await pane.locator('.pdf-outline-tool', { hasText: 'Edit bookmarks' }).click()
      await expect(pane.locator('.pdf-outline-row')).toHaveCount(2)

      // Rename "Beta" through the prompt: ✎ opens with the existing title prefilled, Enter commits
      await pane.locator('.pdf-outline-row').nth(1).locator('button[title="Rename"]').click()
      const prompt = pdf.locator('.pdf-modal .pdf-modal-input')
      await expect(prompt).toHaveValue('Beta')
      await prompt.fill('Beta Renamed')
      await prompt.press('Enter')
      await expect(pane.locator('.pdf-outline-row').nth(1)).toContainText('Beta Renamed')

      // Delete "Alpha": the row holds the title plus ↑ ↓ ✎ ✕ ＋, addressed by title so button
      // arithmetic can't drift; then apply with "Beta" left
      await pane.locator('.pdf-outline-row').first().locator('button[title="Delete"]').click()
      await expect(pane.locator('.pdf-outline-row')).toHaveCount(1)
      await pane
        .locator('.pdf-outline-toolbar .pdf-outline-tool', { hasText: 'Apply bookmarks' })
        .click()

      // Apply rewrote the file and reloaded the document: edit mode closed, the read view shows
      // the surviving bookmark, and there is exactly one left
      await expect(pane.locator('.pdf-outline-row')).toHaveCount(0)
      await expect(pane.locator('.pdf-outline-item')).toHaveCount(1)
      await expect(pane.locator('.pdf-outline-item', { hasText: 'Beta Renamed' })).toBeVisible()
      await pdf.screenshot({ path: screenshotPath('pdf-outline-applied') })

      // ...and the rewrite landed in the file itself, not just the open view
      expect(await outlineTitlesOnDisk(path)).toEqual(['Beta Renamed'])
    } finally {
      await closeReader(launched)
    }
    // Cross-realm and pdf-lib mismatches show up here first
    expect(crashes).toEqual([])
  })

  test('split and sanitize dialogs close without touching the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-pdf-'))
    const path = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    for (let i = 0; i < 3; i++) document.addPage([612, 792])
    document.setTitle('Smoke Title')
    await writeFile(path, await document.save())
    const before = await fileDigest(path)

    const launched = await launchApp({ openFile: path })
    const { app, page } = launched
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))

    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      pdf.on('pageerror', (error) => crashes.push(String(error)))
      await expect(pdf.locator('.ribbon')).toBeVisible()

      // These actions live on the Organize ribbon, not the home tab the app opens with
      await pdf.locator('.ribbon-tab', { hasText: 'Organize' }).click()

      // Split: three modes, then Escape discards without writing anything. The button label is
      // deliberately short ('Split PDF'); the longer wording is the dialog title
      await pdf.locator('.rb-big[title="Split PDF"]').click()
      const split = pdf.locator('.pdf-modal', { hasText: 'Split PDF' })
      const choices = split.locator('.pdf-modal-choices .pdf-modal-choice')
      await expect(choices).toHaveCount(3)
      await pdf.keyboard.press('Escape')
      await expect(split).toHaveCount(0)

      // Sanitize: six categories, Escape again before any checkbox is touched
      await pdf.locator('.rb-big[title="Sanitize"]').click()
      const sanitize = pdf.locator('.pdf-modal', { hasText: 'Sanitize' })
      await expect(sanitize.locator('.pdf-modal-choices .pdf-modal-choice')).toHaveCount(6)
      await pdf.keyboard.press('Escape')
      await expect(sanitize).toHaveCount(0)

      // Export embedded images on a no-image document surfaces the guard through the toolbar's
      // save-error badge instead of a dialog
      await pdf.locator('.rb-big[title="Export Embedded Images"]').click()
      await expect(pdf.locator('.tb-save-error')).toBeVisible({ timeout: 15_000 })

      // The accessibility report sits on the home ribbon — switch back, since ribbon tabs
      // unmount their groups
      await pdf.locator('.ribbon-tab', { hasText: 'Home' }).click()
      await pdf.locator('.rb-big[title="Accessibility"]').click()
      const a11y = pdf.locator('.pdf-a11y-rows')
      await expect(a11y.locator('.pdf-a11y-row')).toHaveCount(8)
      await expect(a11y.locator('.pdf-a11y-pass')).toHaveCount(1)
      await expect(a11y.locator('.pdf-a11y-fail')).toHaveCount(2)
      await expect(a11y.locator('.pdf-a11y-manual')).toHaveCount(5)
      await expect(a11y.locator('.pdf-a11y-row', { hasText: 'Document title' })).toBeVisible()
      await pdf.keyboard.press('Escape')
      await pdf.screenshot({ path: screenshotPath('pdf-dialogs') })

      // Opening and dismissing all of the above is side-effect free: same bytes on disk
      expect(await fileDigest(path)).toBe(before)
    } finally {
      await closeReader(launched)
    }
    expect(crashes).toEqual([])
  })
})

test.describe('direct content editing', () => {
  test('edits a text line and saves an additive FreeText replacement to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-edit-'))
    const path = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    const first = document.addPage([612, 792])
    const font = await document.embedFont(StandardFonts.Helvetica)
    first.drawText('Hello world', { x: 72, y: 650, size: 24, font })
    await writeFile(path, await document.save())

    const launched = await launchApp({ openFile: path })
    const { app, page } = launched
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))

    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      pdf.on('pageerror', (error) => crashes.push(String(error)))
      await expect(pdf.locator('.ribbon')).toBeVisible()

      // Enter Edit PDF: the discovered text line becomes a clickable block
      await pdf.locator('.rb-big[title="Edit PDF"]').click()
      const block = pdf.locator('.pdf-content-block').first()
      await expect(block).toBeVisible({ timeout: 15_000 })
      await block.click()

      // Clicking opens the inline editor prefilled with the line; Enter applies
      const editor = pdf.locator('.pdf-content-editor-text')
      await expect(editor).toBeVisible()
      await expect(editor).toHaveValue('Hello world')
      await editor.fill('Edited text')
      await editor.press('Enter')
      await expect(pdf.locator('.pdf-content-edit-img')).toHaveCount(1)

      // Save reloads the doc, clearing the overlay; the text lives on in the file
      await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
      await expect(pdf.locator('.pdf-content-edit-img')).toHaveCount(0, { timeout: 20_000 })

      const saved = await PDFDocument.load(await readFile(path), { updateMetadata: false })
      const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
      const contents: string[] = []
      for (let i = 0; i < (annots?.size() ?? 0); i++) {
        const annot = saved.context.lookup(annots!.get(i), PDFDict)
        if (annot?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'FreeText') {
          continue
        }
        const text = annot.lookupMaybe(PDFName.of('Contents'), PDFHexString)
        if (text) contents.push(text.decodeText())
      }
      expect(contents).toContain('Edited text')
    } finally {
      await closeReader(launched)
    }
    expect(crashes).toEqual([])
  })
})

/** A throwaway PDF with the requested page count; `text` goes on page one as real page text. */
async function writeTestPdf(path: string, pages: number, text?: string): Promise<void> {
  const document = await PDFDocument.create()
  for (let i = 0; i < pages; i++) document.addPage([612, 792])
  if (text) {
    const font = await document.embedFont(StandardFonts.Helvetica)
    document.getPage(0).drawText(text, { x: 72, y: 650, size: 24, font })
  }
  await writeFile(path, await document.save())
}

test.describe('organize, palette and external rebuilds', () => {
  test('organize grid duplicates the selected page into the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-organize-'))
    const path = join(dir, 'document.pdf')
    await writeTestPdf(path, 1)

    const launched = await launchApp({ openFile: path })
    const { app, page } = launched
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))

    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      pdf.on('pageerror', (error) => crashes.push(String(error)))
      await expect(pdf.locator('.ribbon')).toBeVisible()

      // Home ▸ Pages ▸ Organize pages; a fresh one-page document has one card
      await pdf.locator('.rb-big[title="Organize pages"]').click()
      const grid = pdf.locator('.pdf-organize-grid')
      await expect(grid).toBeVisible()
      await expect(grid.locator('.pdf-organize-card')).toHaveCount(1)

      // Select the card, then duplicate it through the grid's own action
      await grid.locator('.pdf-organize-card').first().click()
      await expect(grid.locator('.pdf-organize-card-active')).toHaveCount(1)
      await grid.locator('button[title="Duplicate page"]').click()

      // The write lands in main, the document reloads, and the grid reflects the new file
      await expect(grid.locator('.pdf-organize-card')).toHaveCount(2, { timeout: 20_000 })
      await expect(grid.locator('.pdf-organize-count')).toHaveText('0 selected')
      await pdf.screenshot({ path: screenshotPath('pdf-organize-duplicate') })

      // Proof is the file itself: two pages, the copy keeping the source's page size
      const saved = await PDFDocument.load(await readFile(path), { updateMetadata: false })
      expect(saved.getPageCount()).toBe(2)
      expect(saved.getPage(1).getSize()).toEqual(saved.getPage(0).getSize())
    } finally {
      await closeReader(launched)
    }
    expect(crashes).toEqual([])
  })

  test('command palette runs Edit PDF from the keyboard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-palette-'))
    const path = join(dir, 'document.pdf')
    await writeTestPdf(path, 1, 'Palette source line')

    const launched = await launchApp({ openFile: path })
    const { app, page } = launched
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))

    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      pdf.on('pageerror', (error) => crashes.push(String(error)))
      await expect(pdf.locator('.ribbon')).toBeVisible()

      // Ctrl/⌘K opens the launcher on a clean query with focus in its input
      await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
      const palette = pdf.locator('.pdf-palette')
      await expect(palette).toBeVisible()
      const input = palette.locator('.pdf-palette-input')
      await expect(input).toBeFocused()

      // Filtering is case-insensitive on the label; Enter runs the single remaining row
      await input.fill('edit pdf')
      await expect(palette.locator('.pdf-palette-row')).toHaveCount(1)
      await input.press('Enter')
      await expect(palette).toHaveCount(0)

      // The command is the ribbon action: Edit PDF is active and its text blocks appear
      await expect(pdf.locator('.rb-big[title="Edit PDF"]')).toHaveClass(/active/)
      await expect(pdf.locator('.pdf-content-block').first()).toBeVisible({ timeout: 15_000 })
      await pdf.screenshot({ path: screenshotPath('pdf-command-palette') })
    } finally {
      await closeReader(launched)
    }
    expect(crashes).toEqual([])
  })

  test('an external rewrite reloads the open document in place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-reload-'))
    const path = join(dir, 'document.pdf')
    await writeTestPdf(path, 1)

    const launched = await launchApp({ openFile: path })
    const { app, page } = launched
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))

    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      pdf.on('pageerror', (error) => crashes.push(String(error)))
      await expect(pdf.locator('.ribbon')).toBeVisible()
      // The sidebar renders one thumbnail per page, so its count is the open document's length
      await expect(pdf.locator('.pdf-thumb')).toHaveCount(1)

      // Simulate a LaTeX/Typst rebuild: replace the file behind the open reader
      await writeTestPdf(path, 2)

      // The watcher (debounced) reloads the clean reader; both the sidebar and status bar follow
      await expect(pdf.locator('.pdf-thumb')).toHaveCount(2, { timeout: 20_000 })
      await expect(pdf.locator('.status-left')).toContainText('of 2')
      await pdf.screenshot({ path: screenshotPath('pdf-auto-reload') })
    } finally {
      await closeReader(launched)
    }
    expect(crashes).toEqual([])
  })
})
