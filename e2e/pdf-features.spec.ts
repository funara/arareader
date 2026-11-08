import { createHash } from 'node:crypto'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import jsQR from 'jsqr'
import type { PdfApi } from '../apps/pdf/src/shared/ipc'
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
  test('shows the sidebar rail only when navigation panes are collapsed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-sidebar-'))
    const path = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    document.addPage([612, 792])
    applyOutline(document, [{ title: 'Bookmark', pageIndex: 0 }])
    await writeFile(path, await document.save())

    const launched = await launchApp({ openFile: path })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      const rail = pdf.locator('.pdf-sidebar-toggle')
      const thumbnails = pdf.locator('.rb-big[title="Thumbnails"]').first()
      await expect(pdf.locator('.pdf-thumb')).toHaveCount(1)
      await expect(rail).toHaveCount(0)

      await thumbnails.click()
      await expect(pdf.locator('.pdf-thumbs')).toHaveCount(0)
      await expect(rail).toHaveAttribute('aria-expanded', 'false')
      await rail.click()
      await expect(pdf.locator('.pdf-thumb')).toHaveCount(1)
      await expect(rail).toHaveCount(0)

      for (const name of ['Outline', 'Comments']) {
        await pdf.locator(`.rb-big[title="${name}"]`).first().click()
        await expect(pdf.locator('.pdf-outline-pane')).toBeVisible()
        await expect(rail).toHaveCount(0)
      }
    } finally {
      await closeReader(launched)
    }
  })

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

test('Read mode restores each PDF workspace and Command Center searches the document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-read-mode-'))
  const first = join(dir, 'first.pdf')
  const second = join(dir, 'second.pdf')
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  page.drawText('A unique searchable document phrase', { x: 70, y: 700 })
  const field = document.getForm().createTextField('sample')
  field.setText('original')
  field.addToPage(page, { x: 70, y: 630, width: 160, height: 24 })
  const bytes = await document.save()
  await writeFile(first, bytes)
  await writeFile(second, bytes)
  const launched = await launchApp({ openFile: first })
  try {
    const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
    const host = launched.page
    const modes = pdf.locator('.ribbon-mode-group')
    const command = pdf.getByRole('button', { name: 'Search commands or PDF…' })
    const hints = command.locator('.ribbon-command-hints-track')
    await expect(command).toBeVisible()
    await expect(command).toHaveCSS('height', '28px')
    await expect(hints.locator('span')).toHaveText([
      'Search commands or PDF…',
      'Find text in this PDF…',
      'Find tools and actions…',
      'Search commands or PDF…',
    ])
    await pdf.emulateMedia({ reducedMotion: 'reduce' })
    await expect(hints).toHaveCSS('animation-name', 'none')
    await expect(command).toHaveAccessibleName('Search commands or PDF…')
    await pdf.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(hints).toHaveCSS('animation-name', 'ribbon-command-roll')
    const offsets = await hints.evaluate((track) => {
      const animation = track.getAnimations()[0]
      animation.pause()
      return [0, 3600, 7200, 10800].map((time) => {
        animation.currentTime = time
        return new DOMMatrixReadOnly(getComputedStyle(track).transform).m42
      })
    })
    for (const [index, offset] of [0, -20, -40, 0].entries()) {
      expect(offsets[index]).toBeCloseTo(offset, 1)
    }
    await hints.evaluate((track) => {
      track.getAnimations()[0].currentTime = 3600
    })
    await pdf.screenshot({ path: screenshotPath('command-center-rolling') })
    await hints.evaluate((track) => track.getAnimations()[0].play())
    await expect(modes.locator('button')).toHaveCount(4)
    await expect(modes.locator('button').first()).toHaveClass(/ai-entry/)
    await expect(modes.locator('button').nth(1)).toHaveAttribute('title', 'Select')
    await expect(modes.locator('button').nth(2)).toHaveAttribute('title', 'Edit PDF')
    await expect(modes.locator('button').nth(3)).toHaveAttribute('title', 'Read mode')
    await expect(modes.locator('button').nth(2)).toHaveText('Edit')
    await expect(modes.locator('button').nth(3)).toHaveText('Read')
    await modes.locator('.ai-entry').click()
    await expect(pdf.locator('.ai-dock')).toHaveClass(/collapsed/)
    await modes.locator('.ai-entry').click()
    await expect(pdf.locator('.ai-dock')).not.toHaveClass(/collapsed/)
    await expect(modes.locator('button[title="Select"]')).toHaveAttribute('aria-pressed', 'true')
    await pdf.screenshot({ path: screenshotPath('production-modes-home') })
    await pdf.emulateMedia({ colorScheme: 'dark' })
    await expect(pdf.locator('html')).toHaveAttribute('data-theme', 'dark')
    await pdf.screenshot({ path: screenshotPath('command-center-dark') })
    await pdf.emulateMedia({ colorScheme: 'light' })
    await expect(pdf.locator('html')).toHaveAttribute('data-theme', 'light')
    const originalViewport = await pdf.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    await pdf.setViewportSize({ width: 320, height: 800 })
    await expect(command).toBeInViewport()
    await expect(command.locator('.ribbon-command-hints')).toBeHidden()
    await expect(command).toHaveAccessibleName('Search commands or PDF…')
    await pdf.screenshot({ path: screenshotPath('command-center-narrow') })
    await modes.locator('button[title="Read mode"]').scrollIntoViewIfNeeded()
    await expect(modes.locator('button[title="Read mode"]')).toBeInViewport()
    await modes.locator('.ai-entry').scrollIntoViewIfNeeded()
    await expect(modes.locator('.ai-entry')).toBeInViewport()
    await pdf.setViewportSize(originalViewport)
    await pdf
      .locator('.ribbon-tab')
      .filter({ hasText: /^View$/ })
      .click()
    await expect(modes.locator('button')).toHaveCount(3)
    await expect(modes.locator('button').nth(1)).toHaveText('Edit')
    await expect(modes.locator('button').nth(2)).toHaveText('Read')
    await pdf
      .locator('.ribbon-tab')
      .filter({ hasText: /^Edit$/ })
      .click()
    await expect(modes).toHaveCount(0)
    await pdf
      .locator('.ribbon-tab')
      .filter({ hasText: /^Home$/ })
      .click()
    await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
    await expect(host.locator('.tab-exit-read')).toBeVisible()
    await host.locator('.tab-exit-read').click()
    await expect(modes.locator('button[title="Select"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(pdf.locator('.pdf-thumb').first()).toBeVisible()
    await expect(pdf.locator('.pdf-sidebar-toggle')).toHaveCount(0)
    await expect(pdf.locator('.ai-dock')).not.toHaveClass(/collapsed/)

    await command.click()
    await expect(command).toHaveAttribute('aria-expanded', 'true')
    await expect(hints).toHaveCSS('animation-play-state', 'paused')
    const input = pdf.locator('.pdf-palette-input')
    await input.press('Escape')
    await expect(pdf.locator('.ribbon-command')).toBeFocused()
    await pdf.locator('.ribbon-command').click()
    await input.fill('unique searchable')
    await expect(pdf.locator('.pdf-palette-row')).toHaveCount(1)
    await expect(pdf.locator('.pdf-palette-row')).toContainText('Search in document')
    await input.press('Enter')
    await expect(pdf.locator('.pdf-search-input')).toHaveValue('unique searchable')
    await expect(pdf.locator('.pdf-search-input')).toBeFocused()
    await expect(pdf.locator('.pdf-search-hit').first()).toBeVisible()
    await pdf.keyboard.press('Escape')

    await pdf.locator('.ribbon-mode-group button[title="Edit PDF"]').click()
    await expect(pdf.locator('.pdf-content-block').first()).toBeVisible()
    const sidebar = pdf.locator('.pdf-sidebar-toggle')
    await pdf.locator('.rb-big[title="Thumbnails"]').first().click()
    await expect(sidebar).toHaveAttribute('aria-expanded', 'false')
    await expect(pdf.locator('.status-file .ribbon-file')).toHaveText('first.pdf')
    await pdf.locator('.ai-entry').first().click()
    await expect(pdf.locator('.ai-dock')).toHaveClass(/collapsed/)
    await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
    await expect(pdf.locator('.ribbon')).toBeHidden()
    await expect(pdf.locator('.ai-dock')).toBeHidden()
    await expect(pdf.locator('.status-bar')).toBeHidden()
    await expect(pdf.locator('.pdf-form-input').first()).toBeDisabled()
    await expect(pdf.locator('.pdf-content-block')).toHaveCount(0)
    await expect(host.locator('.tab-exit-read')).toBeVisible()
    await pdf.screenshot({ path: screenshotPath('production-read-content') })
    await host.screenshot({ path: screenshotPath('production-read-header') })

    await host.evaluate((path) => window.reader.openPath(path), second)
    await expect(host.locator('.tab-item', { hasText: 'second.pdf' })).toBeVisible()
    await expect(host.locator('.tab-exit-read')).toHaveCount(0)
    await host.locator('.tab-item', { hasText: 'first.pdf' }).click()
    await expect(host.locator('.tab-exit-read')).toBeVisible()
    await host.locator('.tab-exit-read').click()
    await expect(pdf.locator('.ribbon')).toBeVisible()
    await expect(pdf.locator('.pdf-form-input').first()).toBeEnabled()
    await expect(pdf.locator('.pdf-content-block').first()).toBeVisible()
    await expect(pdf.locator('.ribbon-mode-group button[title="Edit PDF"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(sidebar).toHaveAttribute('aria-expanded', 'false')
    await expect(pdf.locator('.ai-dock')).toHaveClass(/collapsed/)
    await expect(pdf.locator('.status-file .ribbon-file')).toHaveText('first.pdf')
  } finally {
    await closeReader(launched)
  }
})

test('QR Digital signature uses the profile and survives saving', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-qr-'))
  const path = join(dir, 'document.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  await writeFile(path, await document.save())
  const launched = await launchApp({ openFile: path })
  try {
    const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
    const selectMode = pdf.locator('.ribbon-mode-group button[title="Select"]')
    const editMode = pdf.locator('.ribbon-mode-group button[title="Edit PDF"]')
    await expect(selectMode).toHaveAttribute('aria-pressed', 'true')
    await expect(editMode).toHaveAttribute('aria-pressed', 'false')
    await pdf.locator('.ribbon').screenshot({ path: screenshotPath('pdf-modes-wide') })
    const viewport = await pdf.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    await pdf.setViewportSize({ width: 620, height: 800 })
    await pdf.locator('.ribbon-body').evaluate((body) => {
      body.scrollLeft = body.scrollWidth
    })
    const modeBounds = await selectMode.evaluate((button) => {
      const group = button.parentElement!.getBoundingClientRect()
      const toolbar = button.closest('.ribbon-body')!.getBoundingClientRect()
      return { left: group.left - toolbar.left, right: group.right - toolbar.right }
    })
    expect(modeBounds.left).toBeGreaterThanOrEqual(-1)
    expect(modeBounds.right).toBeLessThanOrEqual(1)
    await pdf.locator('.ribbon').screenshot({ path: screenshotPath('pdf-modes-narrow') })
    await pdf.setViewportSize(viewport)
    await pdf.locator('.ribbon-body').evaluate((body) => {
      body.scrollLeft = 0
    })
    await selectMode.click()
    await expect(selectMode).toHaveAttribute('aria-pressed', 'true')
    await editMode.click()
    await editMode.click()
    await expect(editMode).toHaveAttribute('aria-pressed', 'true')
    await expect(selectMode).toHaveAttribute('aria-pressed', 'false')
    await pdf
      .locator('.ribbon-tab')
      .filter({ hasText: /^View$/ })
      .click()
    await expect(selectMode).toBeVisible()
    await expect(editMode).toBeVisible()
    await pdf
      .locator('.ribbon-tab')
      .filter({ hasText: /^Home$/ })
      .click()
    await selectMode.click()
    await pdf.locator('.rb-big[title="Signature"]').first().click()
    const dialog = pdf.locator('.pdf-modal')
    await expect(dialog.getByRole('button', { name: 'Signature', exact: true })).toHaveClass(
      /active/,
    )
    expect(await dialog.locator('.pdf-sign-tabs button').allTextContents()).toEqual([
      'Signature',
      'QR Signature',
      'Draw',
      'Image',
      'Type',
    ])
    await expect(dialog.getByText('No saved signatures in E-Sign Vault.')).toBeVisible()
    const footerGap = await dialog.evaluate(
      (modal) =>
        modal.getBoundingClientRect().bottom -
        modal.querySelector('.pdf-modal-actions button')!.getBoundingClientRect().bottom,
    )
    expect(footerGap).toBeLessThanOrEqual(24)
    await expect(dialog.getByRole('button', { name: 'Place' })).toBeDisabled()
    await expect(
      dialog.getByText('Then click anywhere on a page to drop it (Esc to cancel)'),
    ).toHaveCount(0)
    await dialog.getByRole('button', { name: 'QR Signature' }).click()
    await expect(dialog.getByLabel('With primary signature')).toBeDisabled()
    await expect(dialog.getByText('Set a primary signature in E-Sign Vault first.')).toBeVisible()
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('E2E Test User')
    await expect(dialog.getByRole('button', { name: 'Place' })).toBeDisabled()
    const name = '李明'.repeat(20)
    await dialog.getByLabel('Name', { exact: true }).fill(name)
    await dialog.getByLabel('Intent').fill('Approval '.repeat(6).trim())
    await dialog.getByLabel('Recipient').fill('ARA '.repeat(12).trim())
    await dialog.screenshot({ path: screenshotPath('pdf-qr-dialog') })
    await expect(dialog.getByText('Save to Vault')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Place' }).click()
    await expect(selectMode).toHaveAttribute('aria-pressed', 'true')
    await pdf
      .locator('.pdf-sign-drop')
      .first()
      .click({ position: { x: 250, y: 250 } })
    await expect(editMode).toHaveAttribute('aria-pressed', 'true')
    await expect(selectMode).toHaveAttribute('aria-pressed', 'false')
    await expect(pdf.locator('.status-file .tb-save-pending')).toBeVisible()
    await pdf.locator('.ai-entry').first().click()
    await expect(pdf.locator('.status-file .tb-save-pending')).toBeVisible()
    await pdf.setViewportSize({ width: 620, height: 800 })
    await expect(pdf.locator('.status-file .tb-save-pending')).toBeInViewport()
    await pdf.screenshot({ path: screenshotPath('production-narrow-unsaved') })
    await pdf.setViewportSize(viewport)
    await pdf.locator('.ai-entry').first().click()
    await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect
      .poll(
        async () => {
          const saved = await PDFDocument.load(await readFile(path), { updateMetadata: false })
          const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
          for (let i = 0; i < (annots?.size() ?? 0); i++) {
            const annot = saved.context.lookup(annots!.get(i), PDFDict)
            if (annot.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Stamp')
              return true
          }
          return false
        },
        { timeout: 20000 },
      )
      .toBe(true)
    await expect(pdf.locator('.tb-save-pending')).toHaveCount(0, { timeout: 20000 })
    const screenshot = await pdf
      .locator('.pdf-page')
      .first()
      .screenshot({ path: screenshotPath('pdf-qr-saved') })
    const image = await loadImage(screenshot)
    // Preserve the on-screen pixels while giving the decoder enough sampling resolution.
    const canvas = createCanvas(image.width * 2, image.height * 2)
    const context = canvas.getContext('2d')
    context.imageSmoothingEnabled = false
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const decoded = jsQR(pixels.data, pixels.width, pixels.height)?.data
    expect(decoded).toContain(`Signed by: ${name}\n`)
    expect(decoded).toContain(`Intent: ${'Approval '.repeat(6).trim()}\n`)
    expect(decoded).toContain(`Recipient: ${'ARA '.repeat(12).trim()}\n`)
    expect(decoded).toMatch(/Date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)
    expect(decoded).toContain('Signed using ARAReader by ARAOffice')
    await pdf.evaluate(async () => {
      const api = (window as Window & { pdfApi: PdfApi }).pdfApi
      const prefs = await api.getPreferences!()
      await api.setPreferences!({ ...prefs, profile: { ...prefs.profile, fullName: '' } })
    })
    await pdf.locator('.rb-big[title="Signature"]').first().click()
    await dialog.getByRole('button', { name: 'QR Signature' }).click()
    await expect(dialog.getByLabel('Name', { exact: true })).toBeEmpty()
    await dialog.getByLabel('Intent').fill('Approval')
    await dialog.getByLabel('Recipient').fill('ARA')
    await expect(dialog.getByRole('button', { name: 'Place' })).toBeDisabled()
    await dialog.getByLabel('Name', { exact: true }).fill('Manual Name')
    await expect(dialog.getByRole('button', { name: 'Place' })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  } finally {
    await closeReader(launched)
  }
})

for (const kind of ['strokes', 'image'] as const) {
  test(`QR Digital combines a transparent stamp with the primary ${kind} signature`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-qr-primary-'))
    const path = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    document.addPage([612, 792])
    await writeFile(path, await document.save())
    const launched = await launchApp({ openFile: path })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      const imgCanvas = createCanvas(420, 150)
      const imgCtx = imgCanvas.getContext('2d')
      imgCtx.strokeStyle = '#0000ff'
      imgCtx.lineWidth = 5
      imgCtx.beginPath()
      imgCtx.moveTo(10, 110)
      imgCtx.lineTo(400, 20)
      imgCtx.stroke()
      const image = imgCanvas.toDataURL('image/png').split(',')[1]!
      await pdf.evaluate(
        async ({ kind, image }) => {
          const api = (window as Window & { pdfApi: PdfApi }).pdfApi
          const prefs = await api.getPreferences!()
          await api.setPreferences!({
            ...prefs,
            signatures: [
              {
                id: 'primary',
                label: 'Primary Signature',
                kind,
                width: 420,
                height: 150,
                paths: [[10, 110, 400, 20]],
                image,
                color: [0, 0, 1],
                createdAt: 1,
                isDefault: true,
              },
              {
                id: 'alternate',
                label: 'Alternate Signature',
                kind: 'image',
                width: 420,
                height: 150,
                image,
                createdAt: 2,
                isDefault: false,
              },
            ],
          })
        },
        { kind, image },
      )
      await pdf.evaluate(
        (theme) => window.document.documentElement.setAttribute('data-theme', theme),
        kind === 'image' ? 'dark' : 'light',
      )
      await pdf.locator('.rb-big[title="Signature"]').first().click()
      const dialog = pdf.locator('.pdf-modal')
      await dialog.getByRole('button', { name: 'Signature', exact: true }).click()
      await expect(dialog.getByRole('button', { name: /Primary Signature/ })).toBeVisible()
      await expect(dialog.locator('.pdf-sign-saved-preview')).toBeVisible()
      const alternate = dialog.getByRole('button', { name: 'Alternate Signature' })
      await alternate.click()
      await expect(alternate).toHaveClass(/active/)
      await expect(dialog.locator('.pdf-sign-saved-preview img')).toBeVisible()
      await dialog.getByRole('button', { name: /Primary Signature/ }).click()
      expect(
        await pdf.evaluate(
          async () =>
            (
              await (window as Window & { pdfApi: PdfApi }).pdfApi.getPreferences!()
            ).signatures.find((item) => item.isDefault)?.id,
        ),
      ).toBe('primary')
      await dialog.getByRole('button', { name: 'Place' }).click()
      await expect(pdf.locator('.pdf-sign-drop')).toHaveCount(1)
      await pdf.locator('.pdf-sign-drop').hover({ position: { x: 250, y: 250 } })
      if (kind === 'strokes') {
        await expect(pdf.locator('.pdf-sign-ghost polyline')).toHaveAttribute(
          'stroke',
          'rgb(0, 0, 255)',
        )
        await pdf.locator('.pdf-sign-drop').click({ position: { x: 250, y: 250 } })
        await expect(pdf.locator('.ribbon-mode-group button[title="Edit PDF"]')).toHaveAttribute(
          'aria-pressed',
          'true',
        )
        await pdf.locator('.ribbon-mode-group button[title="Select"]').click()
        const ink = pdf.locator('.pdf-draw-shape').first()
        const before = (await ink.boundingBox())!
        await pdf.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
        await pdf.mouse.down()
        await pdf.mouse.move(before.x + before.width / 2 + 30, before.y + before.height / 2 + 30)
        await pdf.mouse.up()
        expect((await ink.boundingBox())!.x).toBeCloseTo(before.x, 0)
        await pdf.keyboard.press('Escape')
        await pdf.locator('.rb-big[title="Edit PDF"]').first().click()
        await pdf.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
        await pdf.mouse.down()
        await pdf.mouse.move(before.x + before.width / 2 + 30, before.y + before.height / 2 + 30)
        await pdf.mouse.up()
        expect((await ink.boundingBox())!.x).toBeGreaterThan(before.x + 20)
        await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
        await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
        await pdf.locator('.ribbon-mode-group button[title="Select"]').click()
      } else {
        await expect(pdf.locator('.pdf-sign-ghost img')).toBeVisible()
      }
      await pdf.keyboard.press('Escape')
      await expect(pdf.locator('.pdf-sign-drop')).toHaveCount(0)
      await expect(pdf.locator('.ribbon-mode-group button[title="Select"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await pdf.locator('.rb-big[title="Signature"]').first().click()
      await dialog.getByRole('button', { name: 'QR Signature' }).click()
      const checkbox = dialog.getByRole('switch', { name: 'With primary signature' })
      await expect(checkbox).toBeEnabled()
      await expect(checkbox).not.toBeChecked()
      const caption = dialog.getByText('Drag items or resize the signature', { exact: true })
      await expect(caption).toHaveCount(0)
      await checkbox.focus()
      await checkbox.press('Space')
      await expect(checkbox).toBeChecked()
      await expect(caption).toBeVisible()
      expect(
        await caption.evaluate((el) =>
          el.previousElementSibling?.classList.contains('pdf-sign-switch'),
        ),
      ).toBe(true)
      await expect(dialog.getByRole('button', { name: 'Move QR and details' })).toBeVisible()
      await dialog.getByLabel('Name', { exact: true }).fill('Adhi')
      await dialog.getByLabel('Intent').fill('Approval')
      await dialog.getByLabel('Recipient').fill('ARA')
      const qrPreview = dialog.getByRole('button', { name: 'Move QR and details' })
      const signaturePreview = dialog.getByRole('button', { name: 'Move primary signature' })
      await expect(qrPreview).toBeVisible()
      const previewStage = dialog.locator('.pdf-sign-layout-stage')
      const wideLayout = await previewStage.evaluate((stage) => {
        const rect = stage.getBoundingClientRect()
        const fields = stage
          .closest('.pdf-sign-qr-layout')!
          .querySelector('.pdf-sign-qr-fields')!
          .getBoundingClientRect()
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          fieldsTop: fields.top,
          fieldsRight: fields.right,
          modalWidth: stage.closest('.pdf-modal')!.getBoundingClientRect().width,
          placeRight: stage
            .closest('.pdf-modal')!
            .querySelector('.pdf-modal-actions button:last-child')!
            .getBoundingClientRect().right,
        }
      })
      expect(Math.abs(wideLayout.width - wideLayout.height)).toBeLessThan(1)
      expect(wideLayout.width).toBeLessThanOrEqual(240)
      expect(wideLayout.modalWidth).toBeLessThanOrEqual(600)
      expect(wideLayout.left - wideLayout.fieldsRight).toBeCloseTo(16, 0)
      expect(Math.abs(wideLayout.top - wideLayout.fieldsTop)).toBeLessThan(1)
      expect(Math.abs(wideLayout.right - wideLayout.placeRight)).toBeLessThan(1)
      const qrFooterGap = await dialog.evaluate(
        (modal) =>
          modal.getBoundingClientRect().bottom -
          modal.querySelector('.pdf-modal-actions button')!.getBoundingClientRect().bottom,
      )
      expect(qrFooterGap).toBeLessThanOrEqual(24)
      if (kind === 'image') {
        const originalSize = await pdf.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }))
        await pdf.setViewportSize({ width: 620, height: 800 })
        const narrowLayout = await previewStage.evaluate((stage) => {
          const rect = stage.getBoundingClientRect()
          const fields = stage
            .closest('.pdf-sign-qr-layout')!
            .querySelector('.pdf-sign-qr-fields')!
            .getBoundingClientRect()
          const modal = stage.closest('.pdf-modal')!.getBoundingClientRect()
          return {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            fieldsBottom: fields.bottom,
            modalLeft: modal.left,
            modalRight: modal.right,
            mask: stage.closest('.pdf-modal-mask')!.getBoundingClientRect().toJSON(),
          }
        })
        expect(Math.abs(narrowLayout.width - narrowLayout.height)).toBeLessThan(1)
        expect(narrowLayout.top).toBeGreaterThan(narrowLayout.fieldsBottom)
        expect(narrowLayout.modalLeft).toBeGreaterThanOrEqual(narrowLayout.mask.left)
        expect(narrowLayout.modalRight).toBeLessThanOrEqual(narrowLayout.mask.right)
        await dialog.screenshot({ path: screenshotPath('pdf-qr-preview-narrow') })
        await pdf.setViewportSize(originalSize)
      }
      const assertInBounds = async () => {
        const inside = await previewStage.evaluate((stage) => {
          const bounds = stage.getBoundingClientRect()
          return Array.from(stage.querySelectorAll<HTMLElement>('.pdf-sign-layout-item')).every(
            (item) => {
              const rect = item.getBoundingClientRect()
              return (
                rect.left >= bounds.left &&
                rect.top >= bounds.top &&
                rect.right <= bounds.right &&
                rect.bottom <= bounds.bottom
              )
            },
          )
        })
        expect(inside).toBe(true)
      }
      const resizeLimit = dialog.getByRole('slider', { name: 'Resize primary signature' })
      for (let i = 0; i < 55; i++) await resizeLimit.press('ArrowRight')
      const limit = await resizeLimit.getAttribute('aria-valuenow')
      expect(Number(limit)).toBeGreaterThan(250)
      const edgeGap = await previewStage.evaluate((stage) => {
        const bounds = stage.getBoundingClientRect()
        const signature = stage
          .querySelector<HTMLElement>('[aria-label="Move primary signature"]')!
          .getBoundingClientRect()
        return Math.min(
          Math.abs(bounds.right - signature.right),
          Math.abs(bounds.bottom - signature.bottom),
        )
      })
      expect(edgeGap).toBeLessThanOrEqual(2)
      await resizeLimit.press('ArrowRight')
      await expect(resizeLimit).toHaveAttribute('aria-valuenow', limit!)
      await assertInBounds()
      for (let i = 0; i < 55; i++) await resizeLimit.press('ArrowLeft')
      await expect(resizeLimit).toHaveAttribute('aria-valuenow', '35')
      for (let i = 0; i < 13; i++) await resizeLimit.press('ArrowRight')
      await expect(resizeLimit).toHaveAttribute('aria-valuenow', '100')
      for (let i = 0; i < 5; i++) await signaturePreview.press('ArrowDown')
      const qrBox = await qrPreview.boundingBox()
      await pdf.mouse.move(qrBox!.x + qrBox!.width / 2, qrBox!.y + qrBox!.height / 2)
      await pdf.mouse.down()
      await pdf.mouse.move(qrBox!.x + qrBox!.width / 2 - 25, qrBox!.y + qrBox!.height / 2, {
        steps: 5,
      })
      await pdf.mouse.up()
      const sigBox = await signaturePreview.boundingBox()
      await pdf.mouse.move(sigBox!.x + 5, sigBox!.y + sigBox!.height / 2)
      await pdf.mouse.down()
      await pdf.mouse.move(sigBox!.x + 5, sigBox!.y + sigBox!.height / 2 + 4, { steps: 3 })
      await pdf.mouse.up()
      expect((await signaturePreview.boundingBox())!.y).toBeGreaterThan(sigBox!.y + 2)
      await assertInBounds()
      const overlap = await previewStage.evaluate((stage) => {
        const sig = stage
          .querySelector<HTMLElement>('[aria-label="Move primary signature"]')!
          .getBoundingClientRect()
        const qrElement = stage.querySelector<HTMLElement>('[aria-label="Move QR and details"]')!
        const qr = qrElement.getBoundingClientRect()
        const left = Math.max(sig.left, qr.left),
          right = Math.min(sig.right, qr.right)
        const top = Math.max(sig.top, qr.top),
          bottom = Math.min(sig.bottom, qr.bottom)
        return {
          overlap: left < right && top < bottom,
          qrOnTop:
            window.document
              .elementFromPoint((left + right) / 2, (top + bottom) / 2)
              ?.closest('button') === qrElement,
        }
      })
      expect(overlap.overlap).toBe(true)
      expect(overlap.qrOnTop).toBe(true)
      await dialog.getByLabel('Name', { exact: true }).fill('李'.repeat(80))
      await expect(qrPreview).toBeVisible()
      await assertInBounds()
      const overlapLayout = await previewStage.evaluate((stage) => {
        const sig = stage.querySelector<HTMLElement>('[aria-label="Move primary signature"]')!
        const qr = stage.querySelector<HTMLElement>('[aria-label="Move QR and details"]')!
        return {
          sigX: (parseFloat(sig.style.left) * 4) / 100,
          sigY: (parseFloat(sig.style.top) * 4) / 100,
          sigHeight: (parseFloat(sig.style.height) * 4) / 100,
          qrX: (parseFloat(qr.style.left) * 4) / 100,
          qrY: (parseFloat(qr.style.top) * 4) / 100,
        }
      })
      await dialog.getByRole('button', { name: 'Place' }).click()
      await pdf.locator('.pdf-sign-drop').hover({ position: { x: 250, y: 250 } })
      const collisionSrc = await pdf.locator('.pdf-sign-ghost img').getAttribute('src')
      const collisionStamp = await loadImage(Buffer.from(collisionSrc!.split(',')[1]!, 'base64'))
      const collisionCanvas = createCanvas(collisionStamp.width, collisionStamp.height)
      const collisionCtx = collisionCanvas.getContext('2d')
      collisionCtx.drawImage(collisionStamp, 0, 0)
      const overlapUnit =
        collisionStamp.height /
        Math.max(overlapLayout.qrY + 1, overlapLayout.sigY + overlapLayout.sigHeight)
      const inkScale = (overlapUnit * overlapLayout.sigHeight) / 150
      const inkX = Math.round(overlapLayout.sigX * overlapUnit) + 10 * inkScale
      const inkY = Math.round(overlapLayout.sigY * overlapUnit) + 110 * inkScale
      const hiddenX = Math.round(overlapLayout.qrX * overlapUnit) + 12
      const hiddenY = Math.round(inkY - (90 / 390) * (hiddenX - inkX))
      expect(hiddenY).toBeGreaterThan(Math.round(overlapLayout.qrY * overlapUnit))
      expect(collisionCtx.getImageData(hiddenX, hiddenY, 1, 1).data[3]).toBe(0)
      const visibleX = Math.round(inkX + 50 * inkScale)
      const visibleY = Math.round(inkY - (50 * inkScale * 90) / 390)
      expect(collisionCtx.getImageData(visibleX, visibleY, 1, 1).data[3]).toBeGreaterThan(0)
      collisionCtx.fillStyle = '#fff'
      collisionCtx.fillRect(0, 0, collisionStamp.width, collisionStamp.height)
      collisionCtx.drawImage(collisionStamp, 0, 0)
      const collisionPixels = collisionCtx.getImageData(
        0,
        0,
        collisionStamp.width,
        collisionStamp.height,
      )
      expect(
        jsQR(collisionPixels.data, collisionStamp.width, collisionStamp.height)?.data,
      ).toContain(`Signed by: ${'李'.repeat(80)}\n`)
      await pdf.keyboard.press('Escape')
      await pdf.locator('.rb-big[title="Signature"]').first().click()
      await dialog.getByRole('button', { name: 'QR Signature' }).click()
      await dialog.locator('.pdf-sign-switch-track').click()
      await expect(checkbox).toBeChecked()
      await dialog.getByLabel('Name', { exact: true }).fill('Adhi')
      await dialog.getByLabel('Intent').fill('Approval')
      await dialog.getByLabel('Recipient').fill('ARA')
      await expect(qrPreview).toBeVisible()
      const beforeLeft = await qrPreview.evaluate((el) => el.style.left)
      await qrPreview.focus()
      await qrPreview.press('ArrowRight')
      await expect(qrPreview).not.toHaveAttribute('style', new RegExp(`left: ${beforeLeft}`))
      for (let i = 0; i < 8; i++) await qrPreview.press('ArrowDown')
      const resize = dialog.getByRole('slider', { name: 'Resize primary signature' })
      await expect(resize).toHaveAttribute('aria-valuenow', '100')
      const originalSignature = await signaturePreview.boundingBox()
      await resize.focus()
      for (let i = 0; i < 4; i++) await resize.press('ArrowRight')
      await expect(resize).toHaveAttribute('aria-valuenow', '120')
      const enlarged = await signaturePreview.boundingBox()
      expect(enlarged!.width).toBeGreaterThan(originalSignature!.width)
      expect(enlarged!.width / enlarged!.height).toBeCloseTo(
        originalSignature!.width / originalSignature!.height,
        1,
      )
      const handleBox = await resize.boundingBox()
      await pdf.mouse.move(
        handleBox!.x + handleBox!.width / 2,
        handleBox!.y + handleBox!.height / 2,
      )
      await pdf.mouse.down()
      await pdf.mouse.move(
        handleBox!.x + handleBox!.width / 2 - 8,
        handleBox!.y + handleBox!.height / 2 - 4,
        { steps: 4 },
      )
      await pdf.mouse.up()
      const reduced = await signaturePreview.boundingBox()
      expect(reduced!.width).toBeLessThan(enlarged!.width)
      expect(reduced!.width).toBeGreaterThan(originalSignature!.width)
      await assertInBounds()
      const beforeTop = await signaturePreview.evaluate((el) => el.style.top)
      const box = await signaturePreview.boundingBox()
      expect(box).not.toBeNull()
      await pdf.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await pdf.mouse.down()
      await pdf.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 15, { steps: 4 })
      await pdf.mouse.up()
      await expect(signaturePreview).not.toHaveAttribute('style', new RegExp(`top: ${beforeTop}`))
      await dialog.screenshot({ path: screenshotPath(`pdf-qr-preview-${kind}`) })
      const previewGeometry = await dialog.locator('.pdf-sign-layout-stage').evaluate((stage) => {
        const signature = stage.querySelector<HTMLElement>('[aria-label="Move primary signature"]')!
        const qr = stage.querySelector<HTMLElement>('[aria-label="Move QR and details"]')!
        return {
          signatureX: (parseFloat(signature.style.left) * 4) / 100,
          signatureWidth: (parseFloat(signature.style.width) * 4) / 100,
          signatureY: (parseFloat(signature.style.top) * 4) / 100,
          signatureHeight: (parseFloat(signature.style.height) * 4) / 100,
          qrY: (parseFloat(qr.style.top) * 4) / 100,
        }
      })
      await dialog.getByRole('button', { name: 'Place' }).click()
      const drop = pdf.locator('.pdf-sign-drop').first()
      await drop.hover({ position: { x: 250, y: 250 } })
      const src = await pdf.locator('.pdf-sign-ghost img').getAttribute('src')
      expect(src).toBeTruthy()
      const stamp = await loadImage(Buffer.from(src!.split(',')[1]!, 'base64'))
      const canvas = createCanvas(stamp.width, stamp.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(stamp, 0, 0)
      const data = ctx.getImageData(0, 0, stamp.width, stamp.height).data
      expect(data[3]).toBe(0)
      const unit =
        stamp.height /
        Math.max(
          previewGeometry.qrY + 1,
          previewGeometry.signatureY + previewGeometry.signatureHeight,
        )
      let bluePixels = 0
      let minBlueY = stamp.height
      let maxBlueY = 0
      for (let i = 0; i < data.length; i += 4) {
        const x = (i / 4) % stamp.width
        const y = Math.floor(i / 4 / stamp.width)
        if (
          data[i + 2]! > 180 &&
          data[i]! < 80 &&
          data[i + 3]! > 100 &&
          x >= previewGeometry.signatureX * unit - 2 &&
          x <= (previewGeometry.signatureX + previewGeometry.signatureWidth) * unit + 2 &&
          y >= previewGeometry.signatureY * unit - 2 &&
          y <= (previewGeometry.signatureY + previewGeometry.signatureHeight) * unit + 2
        ) {
          bluePixels++
          minBlueY = Math.min(minBlueY, y)
          maxBlueY = Math.max(maxBlueY, y)
        }
      }
      expect(bluePixels).toBeGreaterThan(10)
      const onWhite = createCanvas(stamp.width, stamp.height)
      const whiteCtx = onWhite.getContext('2d')
      whiteCtx.fillStyle = '#fff'
      whiteCtx.fillRect(0, 0, stamp.width, stamp.height)
      whiteCtx.drawImage(stamp, 0, 0)
      const renderedStamp = whiteCtx.getImageData(0, 0, stamp.width, stamp.height)
      const decodedStamp = jsQR(renderedStamp.data, stamp.width, stamp.height)
      expect(decodedStamp?.data).toContain('Signed by: Adhi\n')
      expect(decodedStamp!.location.topLeftCorner.y).toBeCloseTo(
        previewGeometry.qrY * unit + 24,
        -1,
      )
      const sigScale = (unit * previewGeometry.signatureHeight) / 150
      expect(Math.abs(minBlueY - (previewGeometry.signatureY * unit + 20 * sigScale))).toBeLessThan(
        8,
      )
      expect(
        Math.abs(maxBlueY - (previewGeometry.signatureY * unit + 110 * sigScale)),
      ).toBeLessThan(8)
      await drop.click({ position: { x: 250, y: 250 } })
      await pdf.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            async write(items: ClipboardItem[]) {
              const blob = await items[0]!.getType('image/png')
              const bytes = new Uint8Array(await blob.arrayBuffer())
              window.document.documentElement.dataset.copiedPng = btoa(
                Array.from(bytes, (b) => String.fromCharCode(b)).join(''),
              )
            },
          },
        })
      })
      const editButton = pdf.locator('.ribbon-mode-group button[title="Edit PDF"]')
      const selectButton = pdf.locator('.ribbon-mode-group button[title="Select"]')
      await expect(editButton).toHaveAttribute('aria-pressed', 'true')
      const shape = pdf.locator('.pdf-draw-shape').first()
      await selectButton.click()
      const beforeSelectDrag = (await shape.boundingBox())!
      await pdf.mouse.move(beforeSelectDrag.x + 10, beforeSelectDrag.y + 10)
      expect(await shape.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
      await pdf.mouse.click(beforeSelectDrag.x + 10, beforeSelectDrag.y + 10)
      await expect(pdf.locator('.pdf-del-popup')).toHaveCount(0)
      await pdf.keyboard.press('Delete')
      await expect(shape).toHaveCount(1)
      await pdf.mouse.down()
      await pdf.mouse.move(beforeSelectDrag.x + 40, beforeSelectDrag.y + 40)
      await pdf.mouse.up()
      const afterSelectDrag = (await shape.boundingBox())!
      expect(afterSelectDrag.x).toBeCloseTo(beforeSelectDrag.x, 0)
      expect(afterSelectDrag.y).toBeCloseTo(beforeSelectDrag.y, 0)
      await expect(pdf.locator('.pdf-draw-handle')).toHaveCount(0)

      await editButton.click()
      await expect(editButton).toHaveClass(/active/)
      await pdf.keyboard.press('Escape')
      const beforeEditDrag = (await shape.boundingBox())!
      await pdf.mouse.move(beforeEditDrag.x + 10, beforeEditDrag.y + 10)
      await pdf.mouse.down()
      await pdf.mouse.move(beforeEditDrag.x + 40, beforeEditDrag.y + 40)
      await pdf.mouse.up()
      const afterEditDrag = (await shape.boundingBox())!
      expect(afterEditDrag.x).toBeGreaterThan(beforeEditDrag.x + 20)
      await shape.click({ position: { x: 10, y: 10 } })
      const handles = pdf.locator('.pdf-draw-handle')
      await expect(handles).toHaveCount(4)
      const corner = (await handles.first().boundingBox())!
      await pdf.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
      await pdf.mouse.down()
      await pdf.mouse.move(corner.x + corner.width / 2 - 30, corner.y + corner.height / 2 - 30)
      await pdf.mouse.up()
      const afterResize = (await shape.boundingBox())!
      expect(afterResize.width).toBeGreaterThan(afterEditDrag.width + 10)
      await selectButton.click()
      await expect(handles).toHaveCount(0)
      await expect(pdf.locator('.pdf-del-popup')).toHaveCount(0)
      await pdf.keyboard.press('Delete')
      await expect(shape).toHaveCount(1)
      const beforeSecondDrag = (await shape.boundingBox())!
      await pdf.mouse.move(beforeSecondDrag.x + 10, beforeSecondDrag.y + 10)
      await pdf.mouse.down()
      await pdf.mouse.move(beforeSecondDrag.x + 40, beforeSecondDrag.y + 40)
      await pdf.mouse.up()
      expect((await shape.boundingBox())!.x).toBeCloseTo(beforeSecondDrag.x, 0)
      await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
      await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
      await editButton.click()
      await shape.click({ position: { x: 10, y: 10 } })
      const popup = pdf.locator('.pdf-del-popup')
      await popup.getByRole('button', { name: 'Copy' }).click()
      await expect
        .poll(() => pdf.locator('html').getAttribute('data-copied-png'))
        .toBe(src!.split(',')[1])
      await popup.getByRole('button', { name: 'Remove' }).click()
      await expect(pdf.locator('.pdf-draw-shape')).toHaveCount(0)
      await pdf.locator('.pdf-toast').getByRole('button', { name: 'Undo' }).click()
      await expect(pdf.locator('.pdf-draw-shape')).toHaveCount(1)
      await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
      await expect(launched.page.locator('.tab-exit-read')).toBeVisible()
      await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
      await expect(shape).toHaveCount(1)
      await shape.click({ force: true })
      await expect(pdf.locator('.pdf-del-popup')).toHaveCount(0)
      await launched.page.locator('.tab-exit-read').click()
      await expect(editButton).toHaveAttribute('aria-pressed', 'true')
      await expect(pdf.locator('.tb-save-pending')).toBeVisible()
      await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
      await expect(pdf.locator('.tb-save-pending')).toHaveCount(0, { timeout: 20000 })
      const screenshot = await pdf
        .locator('.pdf-page')
        .first()
        .screenshot({ path: screenshotPath(`pdf-qr-primary-${kind}`) })
      const rendered = await loadImage(screenshot)
      const output = createCanvas(rendered.width, rendered.height)
      const outputCtx = output.getContext('2d')
      outputCtx.drawImage(rendered, 0, 0)
      const pixels = outputCtx.getImageData(0, 0, rendered.width, rendered.height)
      expect(jsQR(pixels.data, pixels.width, pixels.height)?.data).toContain('Signed by: Adhi\n')
    } finally {
      await closeReader(launched)
    }
  })
}

test.describe('direct content editing', () => {
  test('outside click cancels a text draft without discarding applied edits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-edit-cancel-'))
    const path = join(dir, 'document.pdf')
    await writeTestPdf(path, 1, 'Hello world')
    const original = await fileDigest(path)
    const launched = await launchApp({ openFile: path })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await pdf.locator('.rb-big[title="Edit PDF"]').click()
      const block = pdf.locator('.pdf-content-block').first()
      await expect(block).toBeVisible()
      await block.click()
      const editor = pdf.locator('.pdf-content-editor-text')
      await editor.fill('Unapplied text')
      await pdf.locator('.pdf-content-toolbar button[title="Bold (Ctrl+B)"]').click()
      await expect(editor).toHaveValue('Unapplied text')
      await pdf
        .locator('.pdf-page')
        .first()
        .click({ position: { x: 20, y: 20 } })
      await expect(editor).toHaveCount(0)
      expect(await fileDigest(path)).toBe(original)
      await block.click()
      await expect(editor).toHaveValue('Hello world')
      await editor.fill('Applied text')
      await pdf.locator('.pdf-content-toolbar button', { hasText: 'Apply' }).click()
      await expect(pdf.locator('.pdf-content-edit-img')).toHaveCount(1)
      await block.click()
      await editor.fill('Discard this')
      await pdf
        .locator('.pdf-page')
        .first()
        .click({ position: { x: 20, y: 20 } })
      await expect(editor).toHaveCount(0)
      await block.click()
      await expect(editor).toHaveValue('Applied text')
      await pdf.locator('.pdf-content-toolbar button', { hasText: 'Cancel' }).click()
    } finally {
      await closeReader(launched)
    }
  })

  test('edits a text line and saves an additive FreeText replacement to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-edit-'))
    const path = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    const first = document.addPage([612, 792])
    const font = await document.embedFont(StandardFonts.Helvetica)
    first.drawText('Hello world', { x: 72, y: 650, size: 24, font })
    for (let i = 0; i < 8; i++) document.addPage([612, 792])
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
      await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
      await expect(editor).toHaveCount(0)
      await expect(page.locator('.tab-exit-read')).toBeVisible()
      const scroll = pdf.locator('.pdf-scroll')
      await scroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await expect(pdf.locator('.pdf-row').last()).toBeInViewport()
      await scroll.evaluate((el) => {
        el.scrollTop = 0
      })
      await expect(pdf.locator('.pdf-row').first()).toBeInViewport()
      await page.locator('.tab-exit-read').click()
      await expect(editor).toHaveCount(0)
      await block.click()
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

test.describe('view modes', () => {
  test('footer page layout switch works in Select and Edit and stays in sync with Read mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-footer-spread-'))
    const path = join(dir, 'document.pdf')
    await writeTestPdf(path, 4)
    const launched = await launchApp({ openFile: path })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await pdf.setViewportSize({ width: 980, height: 700 })
      const footer = pdf.locator('.status-view-switch')
      const single = footer.getByRole('button', { name: 'Single page' })
      const dual = footer.getByRole('button', { name: 'Two pages' })
      await expect(single).toBeVisible({ timeout: 3000 })
      await expect(single).toBeInViewport()
      await expect(dual).toBeInViewport()
      await expect(pdf.locator('.zoom-slider')).toBeInViewport()
      await expect(pdf.locator('.status-item').first()).toBeInViewport()
      await expect(single).toHaveAttribute('aria-pressed', 'true')
      await dual.click()
      await expect(dual).toHaveAttribute('aria-pressed', 'true')
      await expect(pdf.locator('.pdf-row').first().locator('.pdf-page')).toHaveCount(2)
      await pdf.locator('.ribbon-mode-group button[title="Edit PDF"]').click()
      await expect(dual).toHaveAttribute('aria-pressed', 'true')
      await single.click()
      await expect(single).toHaveAttribute('aria-pressed', 'true')
      await expect(pdf.locator('.pdf-row').first().locator('.pdf-page')).toHaveCount(1)
      await pdf.locator('.ribbon-tab', { hasText: 'View' }).click()
      await pdf.locator('.rb-big[title="Two pages"]').click()
      await expect(dual).toHaveAttribute('aria-pressed', 'true')
      await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
      await expect(launched.page.getByRole('button', { name: 'Two pages' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    } finally {
      await closeReader(launched)
    }
  })

  test('changes the page spread from the Read mode header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-read-spread-'))
    const path = join(dir, 'document.pdf')
    const second = join(dir, 'second.pdf')
    await writeTestPdf(path, 4)
    await writeTestPdf(second, 2)
    const launched = await launchApp({ openFile: path })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
      const twoPages = launched.page.getByRole('button', { name: 'Two pages' })
      await twoPages.click()
      await expect(twoPages).toHaveAttribute('aria-pressed', 'true')
      await expect(pdf.locator('.pdf-row').first().locator('.pdf-page')).toHaveCount(2)
      const singlePage = launched.page.getByRole('button', { name: 'Single page' })
      await singlePage.click()
      await expect(singlePage).toHaveAttribute('aria-pressed', 'true')
      await expect(pdf.locator('.pdf-row').first().locator('.pdf-page')).toHaveCount(1)
      await twoPages.click()
      await expect(twoPages).toHaveAttribute('aria-pressed', 'true')
      await launched.page.evaluate((file) => window.reader.openPath(file), second)
      await expect(launched.page.locator('.tab-item', { hasText: 'second.pdf' })).toBeVisible()
      await expect(twoPages).toHaveCount(0)
      await launched.page.locator('.tab-item', { hasText: 'document.pdf' }).click()
      await expect(twoPages).toHaveAttribute('aria-pressed', 'true')
      await launched.page.locator('.tab-exit-read').click()
      await pdf.locator('.ribbon-tab', { hasText: 'View' }).click()
      await expect(pdf.locator('.rb-big[title="Two pages"]')).toHaveClass(/active/)
    } finally {
      await closeReader(launched)
    }
  })

  test('flips between continuous scrolling and whole-page turns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-view-'))
    const path = join(dir, 'document.pdf')
    const second = join(dir, 'second.pdf')
    await writeTestPdf(path, 3, 'Hello world')
    await writeTestPdf(second, 1)

    const launched = await launchApp({ openFile: path })
    const { app, page } = launched
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))

    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      pdf.on('pageerror', (error) => crashes.push(String(error)))
      await expect(pdf.locator('.ribbon')).toBeVisible()

      await expect(pdf.locator('.pdf-page')).toHaveCount(3)

      // Enter paged mode from page 3: the page on screen carries over
      await pdf.locator('.pdf-thumb').nth(2).click()
      await expect(pdf.locator('.status-item')).toContainText('Page 3 of 3')
      await pdf.locator('.ribbon-tab', { hasText: 'View' }).click()
      const paged = pdf.locator('.rb-big[title="Page by page"]')
      await paged.click()
      await expect(paged).toHaveAttribute('aria-pressed', 'true')
      await expect(pdf.locator('.pdf-page:visible')).toHaveAttribute('data-orig-idx', '2')

      // Search jumps to the page that holds the match
      await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
      await pdf.locator('.pdf-search-input').fill('Hello')
      await expect(pdf.locator('.pdf-page:visible')).toHaveAttribute('data-orig-idx', '0')
      await pdf.keyboard.press('Escape')
      await expect(pdf.locator('.pdf-search-bar')).toHaveCount(0)

      // Clicking a thumbnail cancels an in-progress content edit
      await pdf.locator('.rb-big[title="Edit PDF"]').click()
      await pdf.locator('.pdf-content-block').first().click()
      const editor = pdf.locator('.pdf-content-editor-text')
      await editor.fill('Draft while paged')
      await pdf.locator('.pdf-thumb').nth(1).click()
      await expect(editor).toHaveCount(0)
      await expect(pdf.locator('.pdf-page:visible')).toHaveAttribute('data-orig-idx', '1')
      await pdf.locator('.pdf-thumb').first().click()
      await pdf.locator('.pdf-content-block').first().click()
      await expect(editor).toHaveValue('Hello world')
      await editor.press('Escape')

      // Whole-page turns stay clamped at the document ends
      await pdf.locator('.pdf-thumb').nth(2).click()
      await pdf.locator('.pdf-scroll').hover()
      await pdf.mouse.wheel(0, 400)
      await expect(pdf.locator('.pdf-page:visible')).toHaveAttribute('data-orig-idx', '2')
      await pdf.keyboard.press('PageDown')
      await expect(pdf.locator('.pdf-page:visible')).toHaveAttribute('data-orig-idx', '2')
      await pdf.mouse.wheel(0, -400)
      await expect(pdf.locator('.pdf-page:visible')).toHaveAttribute('data-orig-idx', '1')
      await pdf.keyboard.press('PageDown')
      await expect(pdf.locator('.pdf-page:visible')).toHaveAttribute('data-orig-idx', '2')

      // Footer switch: back to continuous, then paged again for Read mode
      const footerSwitch = pdf.locator('.status-view-switch')
      await footerSwitch.locator('[title="Continuous"]').click()
      await expect(footerSwitch.locator('[title="Continuous"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(pdf.locator('.pdf-page')).toHaveCount(3)
      await expect(pdf.locator('.status-item')).toContainText('Page 3 of 3')
      await footerSwitch.locator('[title="Page by page"]').click()
      await expect(pdf.locator('.pdf-page:visible')).toHaveAttribute('data-orig-idx', '2')
      await pdf.screenshot({ path: screenshotPath('pdf-view-switch-footer') })

      // Read mode hides the footer; the host header carries the same switch
      await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
      const headerSwitch = page.locator('.tab-view-switch[aria-label="View mode"]')
      const headerPaged = headerSwitch.locator('[title="Page by page"]')
      const headerContinuous = headerSwitch.locator('[title="Continuous"]')
      await expect(headerSwitch).toBeVisible()
      await expect(headerPaged).toHaveAttribute('aria-pressed', 'true')
      await page.screenshot({ path: screenshotPath('pdf-view-switch-read-mode') })
      await headerContinuous.click()
      await expect(headerContinuous).toHaveAttribute('aria-pressed', 'true')
      await expect(pdf.locator('.pdf-page')).toHaveCount(3)
      await headerPaged.click()
      await expect(headerPaged).toHaveAttribute('aria-pressed', 'true')
      await expect(pdf.locator('.pdf-page:visible')).toHaveAttribute('data-orig-idx', '2')

      // Another PDF tab is not in Read mode, so the strip shows no switch for it...
      await page.evaluate((file) => window.reader.openPath(file), second)
      await expect(page.locator('.tab-item', { hasText: 'second.pdf' })).toBeVisible()
      await expect(headerSwitch).toHaveCount(0)
      // ...and returning to the reading tab restores its own state
      await page.locator('.tab-item', { hasText: 'document.pdf' }).click()
      await expect(headerSwitch).toBeVisible()
      await expect(headerPaged).toHaveAttribute('aria-pressed', 'true')

      // Leaving Read mode returns the footer and ribbon, still page-by-page
      await page.locator('.tab-exit-read').click()
      await expect(page.locator('.tab-exit-read')).toHaveCount(0)
      await expect(pdf.locator('.status-view-switch [title="Page by page"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(paged).toHaveAttribute('aria-pressed', 'true')
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

      // Matching actions and document search are both available for the same query.
      await input.fill('edit pdf')
      await expect(palette.locator('.pdf-palette-row')).toHaveCount(2)
      await expect(palette.locator('.pdf-palette-row').last()).toContainText('Search in document')
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
