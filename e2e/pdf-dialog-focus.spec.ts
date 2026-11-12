import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { applyOutline } from '../apps/pdf/src/main/outline-writer'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

test('PDF WebContentsView dialogs have names, contain focus, submit on Enter, and restore focus', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-pdf-dialog-focus-'))
  const path = join(dir, 'synthetic.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([612, 792])
  applyOutline(document, [{ title: 'Original bookmark', pageIndex: 0 }])
  await writeFile(path, await document.save())

  const launched = await launchApp({ openFile: path })
  try {
    const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
    await pdf.locator('.ribbon-tab', { hasText: /^Organize$/ }).click()
    const splitTrigger = pdf.locator('.rb-big[title="Split PDF"]')
    await splitTrigger.click()

    const split = pdf.getByRole('dialog', { name: 'Split PDF' })
    await expect(split).toHaveAttribute('aria-modal', 'true')
    await expect(split.locator('.pdf-modal-input')).toBeFocused()

    const radios = split.getByRole('radio')
    const lastAction = split.getByRole('button', { name: 'OK' })
    await radios.first().focus()
    await pdf.keyboard.press('Shift+Tab')
    await expect(lastAction).toBeFocused()
    await lastAction.focus()
    await pdf.keyboard.press('Tab')
    await expect(radios.first()).toBeFocused()

    await pdf.keyboard.press('Escape')
    await expect(split).toHaveCount(0)
    await expect(splitTrigger).toBeFocused()

    await pdf.locator('.ribbon-tab', { hasText: /^Home$/ }).click()
    await pdf.locator('.rb-big[title="Outline"]').first().click()
    const pane = pdf.locator('.pdf-outline-pane')
    await pane.getByRole('button', { name: 'Edit bookmarks' }).click()
    const renameTrigger = pane.locator('.pdf-outline-row').first().locator('button[title="Rename"]')
    await renameTrigger.click()

    const rename = pdf.getByRole('dialog', { name: 'Rename' })
    const input = rename.locator('.pdf-modal-input')
    await expect(input).toBeFocused()
    await input.fill('Renamed by Enter')
    await input.press('Enter')
    await expect(rename).toHaveCount(0)
    await expect(pane.locator('.pdf-outline-row').first()).toContainText('Renamed by Enter')
    await expect(renameTrigger).toBeFocused()
  } finally {
    await closeReader(launched)
  }
})
