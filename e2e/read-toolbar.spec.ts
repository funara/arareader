import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { expect, test } from '@playwright/test'
import { closeReader, launchApp, screenshotPath, waitForPageWithUrl } from './helpers'

test('Read mode owns fullscreen only when it enters it and restores it across tabs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-read-fullscreen-'))
  const path = join(dir, 'document.pdf')
  const fixture = await PDFDocument.create()
  fixture.addPage([612, 792])
  await writeFile(path, await fixture.save())
  const launched = await launchApp({ openFile: path })
  try {
    const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
    const fullscreen = () =>
      launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())
    const setWindowFullscreen = (enabled: boolean) =>
      launched.app.evaluate(
        ({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setFullScreen(value),
        enabled,
      )
    const bounds = () =>
      launched.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children[0].getBounds(),
      )
    const enter = pdf.locator('.ribbon-mode-group button[title="Read mode"]')
    const toolbar = pdf.locator('.read-toolbar')
    const close = toolbar.getByRole('button', { name: 'Exit Read mode' })
    await expect.poll(fullscreen).toBe(false)
    await enter.click()
    await expect.poll(fullscreen).toBe(true)
    await expect.poll(async () => (await bounds()).y).toBe(0)
    await pdf.screenshot({ path: screenshotPath('read-fullscreen') })
    await toolbar.getByRole('button', { name: 'View mode' }).click()
    await pdf.keyboard.press('Escape')
    await expect(toolbar).toBeVisible()
    await expect.poll(fullscreen).toBe(true)
    await pdf.keyboard.press('Escape')
    await expect(toolbar).toHaveCount(0)
    await expect.poll(fullscreen).toBe(false)
    await expect.poll(async () => (await bounds()).y).toBe(40)

    await pdf.locator('.status-bar').getByRole('button', { name: 'Full Screen' }).click()
    await expect.poll(fullscreen).toBe(true)
    await enter.click()
    await expect(toolbar).toBeVisible()
    await close.click()
    await expect(toolbar).toHaveCount(0)
    await expect.poll(fullscreen).toBe(true)
    await enter.click()
    await expect(toolbar).toBeVisible()
    await pdf.keyboard.press('Escape')
    await expect(toolbar).toHaveCount(0)
    await expect.poll(fullscreen).toBe(true)
    await pdf.locator('.status-bar').getByRole('button', { name: 'Full Screen' }).click()
    await expect.poll(fullscreen).toBe(false)

    await enter.click()
    await expect.poll(fullscreen).toBe(true)
    await setWindowFullscreen(false)
    await expect.poll(fullscreen).toBe(false)
    await expect(toolbar).toBeVisible()
    await expect.poll(async () => (await bounds()).y).toBe(40)
    await setWindowFullscreen(true)
    await expect.poll(fullscreen).toBe(true)
    await close.click()
    await expect(toolbar).toHaveCount(0)
    await expect.poll(fullscreen).toBe(true)
    await setWindowFullscreen(false)
    await expect.poll(fullscreen).toBe(false)

    await enter.click()
    await expect.poll(fullscreen).toBe(true)
    const id = await launched.page.evaluate(
      async () => (await window.readerTabs.list()).find((tab) => tab.active)!.id,
    )
    await launched.page.evaluate(() => window.readerTabs.activate('home'))
    await expect.poll(fullscreen).toBe(false)
    await launched.page.evaluate((tabId) => window.readerTabs.activate(tabId), id)
    await expect.poll(fullscreen).toBe(true)
    await expect(toolbar).toBeVisible()
    await launched.page.evaluate((tabId) => window.readerTabs.close(tabId), id)
    await expect.poll(fullscreen).toBe(false)
  } finally {
    await closeReader(launched)
  }
})

test('Read mode floating toolbar hides only when idle and keeps reading controls usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-read-toolbar-'))
  const path = join(dir, 'document.pdf')
  const fixture = await PDFDocument.create()
  for (let i = 0; i < 4; i++) fixture.addPage([612, 792])
  await writeFile(path, await fixture.save())
  const launched = await launchApp({ openFile: path })
  try {
    const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
    await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
    const toolbar = pdf.locator('.read-toolbar')
    const page = toolbar.locator('input')
    await expect(toolbar).toBeVisible()
    const close = toolbar.getByRole('button', { name: 'Exit Read mode' })
    await expect(close).toHaveAttribute('title', 'Exit Read mode')
    await expect(close).toHaveText('')
    await expect(close.locator('svg[aria-hidden="true"]')).toBeVisible()
    await expect(close).toHaveCSS('width', '36px')
    await expect(close).toHaveCSS('height', '36px')
    await toolbar.screenshot({ path: screenshotPath('read-toolbar-close-light') })
    const expectHoverColors = async () => {
      await close.hover()
      const colors = await close.evaluate((element) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--danger)'
        probe.style.backgroundColor = 'var(--danger-bg)'
        element.appendChild(probe)
        const actual = getComputedStyle(element)
        const expected = getComputedStyle(probe)
        const result = {
          hovered: element.matches(':hover'),
          colorMatches: actual.color === expected.color,
          backgroundMatches: actual.backgroundColor === expected.backgroundColor,
        }
        probe.remove()
        return result
      })
      expect(colors).toEqual({ hovered: true, colorMatches: true, backgroundMatches: true })
    }
    await expectHoverColors()
    await pdf.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await expectHoverColors()
    await pdf.screenshot({
      path: screenshotPath('read-toolbar-close-dark-hover'),
      clip: (await toolbar.boundingBox())!,
    })
    await pdf.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
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
    await expect(close).toBeInViewport()
    await toolbar.screenshot({ path: screenshotPath('read-toolbar-close-narrow') })
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
    await pdf.locator('.ribbon-mode-group button[title="Read mode"]').click()
    await close.focus()
    await expect(close).toBeFocused()
    await pdf.keyboard.press('Enter')
    await expect(toolbar).toHaveCount(0)
    await expect(pdf.locator('.ribbon')).toBeVisible()
  } finally {
    await closeReader(launched)
  }
})
