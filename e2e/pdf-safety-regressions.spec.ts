import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

test('a stale displayed PDF cannot overwrite an external rewrite and pending edits can be discarded by reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-source-conflict-'))
  const path = join(dir, 'synthetic.pdf')
  const original = await PDFDocument.create()
  original.addPage([612, 792])
  original.addPage([420, 420])
  await writeFile(path, await original.save())
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-source-conflict-profile-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: { onboardingCompleted: true, defaultSidebar: 'thumbs', autosave: false },
    }),
  )
  const launched = await launchApp({ openFile: path, userDataDir })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')

  try {
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(2)
    await pdf.locator('.pdf-thumb').nth(1).click()
    await pdf.getByRole('button', { name: 'Organize', exact: true }).click()
    await pdf.locator('.rb-big[title="Rotate right"]').click()
    await expect(pdf.locator('.tb-save-pending')).toHaveText('Unsaved')

    const changed = await PDFDocument.load(await readFile(path))
    changed.insertPage(0, [200, 300])
    await writeFile(path, await changed.save())
    const externalBytes = await readFile(path)

    await pdf.locator('.qa-btn[aria-label="Save"]').click()
    const conflict = pdf.locator('.reader-error-alert[role="alert"]')
    await expect(conflict).toContainText('file changed on disk since it was opened')
    await expect(
      conflict.getByRole('button', { name: 'Reload from disk (discard edits)' }),
    ).toBeVisible()
    await expect(conflict).toContainText('pending edits were kept')
    expect(await readFile(path)).toEqual(externalBytes)
    expect((await PDFDocument.load(await readFile(path))).getPageCount()).toBe(3)

    pdf.once('dialog', (dialog) => void dialog.accept())
    await conflict.getByRole('button', { name: 'Reload from disk (discard edits)' }).click()
    await expect(pdf.locator('.pdf-thumb')).toHaveCount(3)
    await expect(pdf.locator('.tb-save-pending')).toHaveCount(0)
    expect(await readFile(path)).toEqual(externalBytes)
  } finally {
    await closeReader(launched)
    await rm(dir, { recursive: true, force: true })
  }
})

test('the PNG export UI refuses an existing page name without changing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-png-collision-'))
  const outputDir = await mkdtemp(join(tmpdir(), 'arareader-png-output-'))
  const path = join(dir, 'synthetic.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  document.addPage([420, 420])
  await writeFile(path, await document.save())
  const sentinelPath = join(outputDir, 'synthetic-p1.png')
  const sentinel = Buffer.from('existing synthetic PNG')
  await writeFile(sentinelPath, sentinel)

  const launched = await launchApp({ openFile: path })
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')

  try {
    await expect(pdf.locator('.ribbon')).toBeVisible()
    await launched.app.evaluate(({ dialog }, chosenDir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosenDir] })
    }, outputDir)
    await pdf.getByRole('button', { name: 'Organize', exact: true }).click()
    await pdf.locator('.rb-big[title="Export all pages as PNG"]').click()

    await expect(pdf.locator('.reader-error-alert[role="alert"]')).toContainText(
      'file already exists',
    )
    expect(await readFile(sentinelPath)).toEqual(sentinel)
    expect((await readdir(outputDir)).sort()).toEqual(['synthetic-p1.png'])
  } finally {
    await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(outputDir, { recursive: true, force: true }),
    ])
  }
})
