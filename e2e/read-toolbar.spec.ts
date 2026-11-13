import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { expect, test } from '@playwright/test'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

test('Read mode floating toolbar hides only when idle and keeps reading controls usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-read-toolbar-'))
  const path = join(dir, 'document.pdf')
  const document = await PDFDocument.create()
  for (let i = 0; i < 4; i++) document.addPage([612, 792])
  await writeFile(path, await document.save())
  const launched = await launchApp({ openFile: path })
  try {
    const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
    await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
    const toolbar = pdf.locator('.read-toolbar')
    const page = toolbar.locator('input')
    await expect(toolbar).toBeVisible()
    await expect(launched.page.locator('.tab-view-switch, .tab-exit-read')).toHaveCount(0)
    await pdf.mouse.move(10, 100)
    await expect(toolbar).toHaveClass(/is-hidden/, { timeout: 5000 })
    await pdf.mouse.move(20, 100)
    await expect(toolbar).not.toHaveClass(/is-hidden/)
    await page.focus()
    await pdf.waitForTimeout(2800)
    await expect(toolbar).not.toHaveClass(/is-hidden/)
    await pdf.locator('.pdf-scroll').click({ position: { x: 10, y: 100 } })

    const viewport = await pdf.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await pdf.setViewportSize({ width: 360, height: 700 })
    await expect(toolbar.getByRole('button', { name: 'Exit Read mode' })).toBeInViewport()
    await pdf.setViewportSize(viewport)
    await toolbar.hover()
    await pdf.waitForTimeout(2800)
    await expect(toolbar).not.toHaveClass(/is-hidden/)
    const view = toolbar.getByRole('button', { name: 'View mode' })
    await view.click()
    await pdf.mouse.move(10, 100)
    await pdf.waitForTimeout(2800)
    await expect(toolbar).not.toHaveClass(/is-hidden/)
    await toolbar.getByRole('button', { name: 'Page by page' }).click()
    await expect(toolbar.getByRole('button', { name: 'Page by page' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await pdf.keyboard.press('Escape')
    await expect(view).toHaveAttribute('aria-expanded', 'false')
    await expect(toolbar).toBeVisible()

    await toolbar.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page).toHaveValue('2')
    await page.fill('4')
    await page.press('Enter')
    await expect(page).toHaveValue('4')
    await expect(toolbar.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
    await page.fill('0')
    await page.press('Enter')
    await expect(page).toHaveValue('1')
    await page.fill('invalid')
    await page.press('Enter')
    await expect(page).toHaveValue('1')

    const zoomIn = toolbar.getByRole('button', { name: 'Zoom in' })
    const zoom = toolbar.locator('.read-toolbar-popup-anchor').first().locator('> button')
    const initialZoom = await zoom.textContent()
    await zoomIn.click()
    await expect(zoom).not.toHaveText(initialZoom!)
    await zoom.click()
    await toolbar.getByRole('button', { name: 'Fit width' }).click()
    await zoom.click()
    await toolbar.getByRole('button', { name: 'Fit page' }).click()

    await view.click()
    await toolbar.getByRole('button', { name: 'Two pages' }).click()
    await expect(toolbar.getByRole('button', { name: 'Two pages' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await view.click()
    await toolbar.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(page).toHaveValue('3')
    await expect(toolbar.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
    await toolbar.getByRole('button', { name: 'Previous', exact: true }).click()
    await expect(page).toHaveValue('1')
    await pdf.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
    await expect(pdf.locator('.pdf-search-input')).toBeFocused()
    await pdf.keyboard.press('Escape')
    await expect(toolbar).toBeVisible()
    await pdf.keyboard.press('Escape')
    await expect(toolbar).toHaveCount(0)
    await expect(pdf.locator('.ribbon')).toBeVisible()
  } finally {
    await closeReader(launched)
  }
})
