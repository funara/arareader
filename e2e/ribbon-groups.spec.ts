import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { expect, test } from '@playwright/test'
import { closeReader, launchApp, screenshotPath, waitForPageWithUrl } from './helpers'

test('every ribbon tab labels its tool groups without clipping or changing the controls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-ribbon-groups-'))
  const path = join(dir, 'document.pdf')
  const fixture = await PDFDocument.create()
  fixture.addPage([612, 792])
  await writeFile(path, await fixture.save())
  const launched = await launchApp({ openFile: path })
  try {
    const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
    const ribbon = pdf.locator('.ribbon-body')
    const expected: Record<string, string[]> = {
      Home: ['Assistant', 'Modes', 'Navigation', 'Editing', 'Pages', 'Document', 'Reload'],
      AI: ['Assistant', 'Document', 'Pages', 'Document'],
      Edit: ['Editing', 'Sign / Watermark', 'Document', 'Document'],
      Comment: ['Markup', 'Note / Text', 'Draw', 'Color', 'Editing', 'Comments'],
      Organize: [
        'Organize',
        'Rotate left / Rotate right',
        'Pages',
        'Split PDF / Combine PDFs',
        'Export',
        'Document',
      ],
      View: ['Modes', 'View mode', 'Fit width / Fit page', 'Zoom', 'Navigation', 'Document'],
    }
    for (const [tab, labels] of Object.entries(expected)) {
      await pdf
        .locator('.ribbon-tab')
        .filter({ hasText: new RegExp(`^${tab}$`) })
        .click()
      await expect(ribbon).toHaveCSS('height', '72px')
      const groups = ribbon.locator('.ribbon-group[role="group"], .ribbon-modes')
      await expect(groups).toHaveCount(labels.length)
      for (const [index, label] of labels.entries()) {
        const group = groups.nth(index)
        await expect(group).toHaveAccessibleName(label)
        expect(await group.locator('button').count()).toBeGreaterThan(0)
        const geometry = await group.evaluate((element) => {
          const row = element.closest('.ribbon-body')!.getBoundingClientRect()
          const bounds = element.getBoundingClientRect()
          const caption = element.querySelector('.ribbon-modes-label')
          const style = getComputedStyle(element, '::after')
          const standalone = element.classList.contains('ribbon-group--standalone')
          const neighbor = element
            .closest('.ribbon-body')!
            .querySelector('.ribbon-modes, .ribbon-group:not(.ribbon-group--standalone)')!
          return {
            top: bounds.top,
            bottom: bounds.bottom,
            rowTop: row.top,
            rowBottom: row.bottom,
            standalone,
            buttonHeight: element.querySelector('button')!.getBoundingClientRect().height,
            neighborTop: neighbor.getBoundingClientRect().top,
            caption: caption
              ? caption.textContent
              : style.content === 'none'
                ? null
                : style.content.slice(1, -1),
            captionBottom: caption
              ? caption.getBoundingClientRect().bottom
              : bounds.bottom + 2 + parseFloat(style.lineHeight),
          }
        })
        if (geometry.standalone) {
          expect(geometry.caption).toBeNull()
          expect(geometry.buttonHeight).toBe(62)
          expect(geometry.top).toBeCloseTo(geometry.neighborTop, 0)
          expect(geometry.rowBottom - geometry.bottom).toBeGreaterThanOrEqual(4)
          expect(geometry.top - geometry.rowTop).toBeCloseTo(
            geometry.rowBottom - geometry.bottom,
            0,
          )
        } else {
          expect(geometry.caption).toBe(label)
          expect(geometry.rowBottom - geometry.captionBottom).toBeGreaterThanOrEqual(4)
          expect(geometry.top - geometry.rowTop).toBeCloseTo(
            geometry.rowBottom - geometry.captionBottom,
            0,
          )
        }
      }
      await pdf
        .locator('.ribbon')
        .screenshot({ path: screenshotPath(`ribbon-groups-${tab.toLowerCase()}`) })
    }
    await pdf
      .locator('.ribbon-tab')
      .filter({ hasText: /^Home$/ })
      .click()
    await pdf.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await pdf.locator('.ribbon').screenshot({ path: screenshotPath('ribbon-groups-dark') })
    await pdf.setViewportSize({ width: 320, height: 800 })
    const modes = ribbon.getByRole('group', { name: 'Modes' })
    await modes.scrollIntoViewIfNeeded()
    await expect(modes.locator('button[title="Read mode"]')).toBeInViewport()
    await expect(modes.locator('.ribbon-modes-label')).toBeInViewport()
    await pdf.locator('.ribbon').screenshot({ path: screenshotPath('ribbon-groups-narrow') })
    for (const [tab, labels] of Object.entries(expected)) {
      await pdf
        .locator('.ribbon-tab')
        .filter({ hasText: new RegExp(`^${tab}$`) })
        .click()
      const lastGroup = ribbon.locator('.ribbon-group[role="group"], .ribbon-modes').last()
      await lastGroup.scrollIntoViewIfNeeded()
      const lastButton = lastGroup.locator('button').last()
      await lastButton.scrollIntoViewIfNeeded()
      await expect(lastButton).toBeInViewport()
      await expect(lastGroup).toHaveAccessibleName(labels[labels.length - 1])
      const caption = await lastGroup.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const row = element.closest('.ribbon-body')!.getBoundingClientRect()
        const style = getComputedStyle(element, '::after')
        return {
          center: (bounds.left + bounds.right) / 2,
          bottom:
            style.content === 'none'
              ? bounds.bottom
              : bounds.bottom + 2 + parseFloat(style.lineHeight),
          rowBottom: row.bottom,
          width: window.innerWidth,
          text: style.content === 'none' ? null : style.content.slice(1, -1),
        }
      })
      expect(caption.text).toBe(tab === 'Home' ? null : labels[labels.length - 1])
      expect(caption.center).toBeGreaterThan(0)
      expect(caption.center).toBeLessThan(caption.width)
      expect(caption.rowBottom - caption.bottom).toBeGreaterThanOrEqual(4)
    }
  } finally {
    await closeReader(launched)
  }
})
