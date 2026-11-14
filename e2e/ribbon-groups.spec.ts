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
      Home: [
        'Assistant',
        'Modes',
        'Navigation',
        'Quick tools',
        'Page management',
        'Page fit',
        'File actions',
        'Reload',
      ],
      AI: ['Assistant', 'Document insights', 'Current page', 'Outline', 'Translation'],
      Edit: [
        'Text & images',
        'Sign & stamp',
        'Document structure',
        'Privacy & accessibility',
        'Export',
      ],
      Comment: ['Markup', 'Notes & text', 'Draw', 'Color', 'Insert', 'Review'],
      Organize: [
        'Page management',
        'Rotation',
        'Page insertion',
        'Split & merge',
        'Export',
        'Privacy',
      ],
      View: ['Modes', 'Page layout', 'Page fit', 'Zoom', 'Navigation', 'Window', 'File actions'],
    }
    for (const [tab, labels] of Object.entries(expected)) {
      await pdf
        .locator('.ribbon-tab')
        .filter({ hasText: new RegExp(`^${tab}$`) })
        .click()
      await expect(ribbon).toHaveCSS('height', '72px')
      const groups = ribbon.locator('.ribbon-group[role="group"], .ribbon-modes')
      await expect(groups).toHaveCount(labels.length)
      const renderedNames = await groups.evaluateAll((elements) =>
        elements.map(
          (element) =>
            element.getAttribute('aria-label') ??
            document
              .getElementById(element.getAttribute('aria-labelledby') ?? '')
              ?.textContent?.trim(),
        ),
      )
      expect(new Set(renderedNames).size).toBe(renderedNames.length)
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
      if (tab === 'Home' || tab === 'AI') {
        const assistant = ribbon.locator('.ai-entry')
        const spacing = await assistant.evaluate((button) => {
          const icon = button.querySelector('.rb-big-icon')!.getBoundingClientRect()
          const label = button.querySelector('span:last-child')!.getBoundingClientRect()
          return { gap: label.top - icon.bottom, iconHeight: icon.height }
        })
        expect(spacing.gap).toBeGreaterThanOrEqual(5)
        expect(spacing.iconHeight).toBe(26)
        await expect(assistant).toHaveAttribute('aria-pressed', /^(true|false)$/)
      }
      if (tab === 'AI') {
        const document = ribbon.getByRole('group', { name: 'Document insights', exact: true })
        const pages = ribbon.getByRole('group', { name: 'Current page', exact: true })
        const outline = ribbon.getByRole('group', { name: 'Outline', exact: true })
        const translation = ribbon.getByRole('group', { name: 'Translation', exact: true })
        await expect(document.getByRole('button', { name: 'Doc Stats' })).toBeVisible()
        await expect(pages.getByRole('button', { name: 'Proofread Page' })).toBeVisible()
        await expect(outline.getByRole('button', { name: 'Auto Outline' })).toBeVisible()
        await expect(translation.getByRole('button', { name: 'Translate Page' })).toBeVisible()
      }
      const membership: Record<string, Record<string, string[]>> = {
        Home: {
          'Page management': ['Organize pages'],
          'Page fit': ['Fit width', 'Fit page'],
        },
        Organize: {
          'Page management': ['Organize pages', 'Duplicate page', 'Extract page…', 'Delete page'],
          'Page insertion': ['Insert PDF…', 'Insert blank page'],
        },
        View: {
          Window: ['Full Screen'],
          'File actions': ['Properties', 'Reload'],
        },
      }
      for (const [name, buttons] of Object.entries(membership[tab] ?? {})) {
        const group = ribbon.getByRole('group', { name, exact: true })
        const text = await group.locator('button').allTextContents()
        expect(text.map((value) => value.trim())).toEqual(buttons)
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
