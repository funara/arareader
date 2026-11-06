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

test('QR Digital signature uses the profile and survives saving', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-qr-'))
  const path = join(dir, 'document.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  await writeFile(path, await document.save())
  const launched = await launchApp({ openFile: path })
  try {
    const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
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
    await pdf
      .locator('.pdf-sign-drop')
      .first()
      .click({ position: { x: 250, y: 250 } })
    await expect(pdf.locator('.tb-save-pending')).toBeVisible()
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
    const canvas = createCanvas(image.width, image.height)
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, image.width, image.height)
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
      if (kind === 'strokes')
        await expect(pdf.locator('.pdf-sign-ghost polyline')).toHaveAttribute(
          'stroke',
          'rgb(0, 0, 255)',
        )
      else await expect(pdf.locator('.pdf-sign-ghost img')).toBeVisible()
      await pdf.keyboard.press('Escape')
      await expect(pdf.locator('.pdf-sign-drop')).toHaveCount(0)
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
      const shape = pdf.locator('.pdf-draw-shape').first()
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
