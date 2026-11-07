import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { test, expect } from '@playwright/test'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

/**
 * R7: the assistant panel is resizable from the keyboard. The separator is a
 * focusable splitter, so its arrow/Home/End keys must resize the panel and
 * nothing else — the viewer's global page navigation must not claim them.
 */

test.describe('pdf ai panel controls', () => {
  test('the width separator resizes with the keyboard and does not turn the page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-ai-controls-'))
    const pdfPath = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    for (let i = 0; i < 6; i++) {
      const page = document.addPage([612, 792])
      page.drawText(`page ${i + 1}`, { x: 60, y: 700, size: 14 })
    }
    await writeFile(pdfPath, await document.save())

    const launched = await launchApp({ openFile: pdfPath })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      const resizer = pdf.locator('.ai-panel-resizer')
      await expect(resizer).toHaveAttribute('role', 'separator')
      await expect(resizer).toHaveAttribute('aria-orientation', 'vertical')

      const width = async (): Promise<number> => Number(await resizer.getAttribute('aria-valuenow'))
      const scrollTop = (): Promise<number> =>
        pdf.locator('.pdf-scroll').evaluate((el) => Math.round(el.scrollTop))

      const startWidth = await width()
      const startScroll = await scrollTop()

      // arrow keys resize the panel…
      await resizer.focus()
      await pdf.keyboard.press('ArrowRight')
      await expect.poll(width).toBe(startWidth - 16)
      // …and the document the user was reading does not move (no page turn)
      expect(await scrollTop()).toBe(startScroll)

      // Home clamps to the documented minimum, End to the maximum
      await resizer.focus()
      await pdf.keyboard.press('Home')
      await expect.poll(width).toBe(280)
      await expect(resizer).toHaveAttribute('aria-valuemin', '280')
      expect(await scrollTop()).toBe(startScroll)
      expect(Number(await pdf.evaluate(() => localStorage.getItem('pdf-ai-panel-width')))).toBe(280)

      // the same key still navigates when focus is not on a control
      await pdf.locator('.pdf-scroll').click({ position: { x: 8, y: 8 } })
      await pdf.keyboard.press('ArrowDown')
      await expect.poll(scrollTop, { timeout: 5_000 }).not.toBe(startScroll)
    } finally {
      await closeReader(launched)
    }
  })
})
