import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { expect, test } from '@playwright/test'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

test('attachment paths cannot self-grant across the real preload and IPC boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-attachment-e2e-'))
  const pdfPath = join(dir, 'synthetic.pdf')
  const textPath = join(dir, 'synthetic.txt')
  const document = await PDFDocument.create()
  document.addPage()
  await writeFile(pdfPath, await document.save())
  await writeFile(textPath, 'synthetic attachment')
  const launched = await launchApp({ openFile: pdfPath })
  try {
    const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
    const before = await pdf.evaluate(async (path) => {
      const added = await window.pdfApi.addAttachmentPaths([path])
      const read = await window.pdfApi.readAttachment(path, 0, 100)
      return { added, read }
    }, textPath)
    expect(before.added.accepted).toEqual([])
    expect(before.added.ungranted).toEqual([textPath])
    expect(before.read.ok).toBe(false)

    // This tests IPC wiring, not the OS dialog or event provenance.
    await launched.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, textPath)
    const after = await pdf.evaluate(async (path) => {
      const picked = await window.pdfApi.pickAttachments()
      const read = await window.pdfApi.readAttachment(path, 0, 100)
      return { picked, read }
    }, textPath)
    expect(after.picked?.accepted).toHaveLength(1)
    expect(after.read.text).toBe('synthetic attachment')
  } finally {
    await closeReader(launched)
    await rm(dir, { recursive: true, force: true })
  }
})
