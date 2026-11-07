import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { test, expect } from '@playwright/test'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

/**
 * Restored transcripts are the part of the AI panel that no unit test can
 * prove: the real store index, the real New-chat boundary and the real panel
 * have to agree on what "earlier conversation" means after a reload, and the
 * old conversation must stay reachable without being fed back to the model.
 *
 * The transcript is seeded on disk (schema written by project-store) and the
 * app runs without a provider key, so no network request can happen: what the
 * assertions see is exactly what a real reload would restore.
 */

function chatIdFor(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

test.describe('pdf ai history', () => {
  test('a New-chat boundary survives a reload and keeps the earlier conversation reachable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-ai-history-'))
    const pdfPath = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    document.addPage([612, 792])
    document.addPage([612, 792])
    await writeFile(pdfPath, await document.save())

    const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-ai-history-profile-'))
    const chatId = chatIdFor(pdfPath)
    const chatsDir = join(userDataDir, 'projects', 'default', 'chats')
    await mkdir(chatsDir, { recursive: true })
    // Four records: two from the frozen conversation, two from the active one.
    // The last assistant turn was stopped mid-run after editing page 1.
    const records = [
      { seq: 0, ts: '2024-01-01T00:00:00.000Z', role: 'user', text: 'old question' },
      { seq: 1, ts: '2024-01-01T00:00:01.000Z', role: 'assistant', text: 'old answer' },
      { seq: 2, ts: '2024-01-01T00:00:02.000Z', role: 'user', text: 'new question' },
      {
        seq: 3,
        ts: '2024-01-01T00:00:03.000Z',
        role: 'assistant',
        text: 'partial answer',
        status: 'stopped',
        tools: [{ name: 'edit_text_block', summary: 'Edited page 1', mutated: true }],
      },
    ]
    await writeFile(
      join(chatsDir, `${chatId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    )
    await writeFile(
      join(userDataDir, 'projects', 'index.json'),
      JSON.stringify(
        {
          projects: [],
          fileMap: { [pdfPath]: 'default' },
          chatIdByPath: { [pdfPath]: chatId },
          chatBoundaryByChatId: { [chatId]: 2 },
        },
        null,
        2,
      ),
      'utf8',
    )
    await mkdir(join(userDataDir, 'projects', 'default'), { recursive: true })
    await writeFile(
      join(userDataDir, 'projects', 'default', 'project.json'),
      JSON.stringify(
        {
          id: 'default',
          name: 'Default Project',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          files: [pdfPath],
        },
        null,
        2,
      ),
      'utf8',
    )

    const launched = await launchApp({ openFile: pdfPath, userDataDir })
    const { app } = launched
    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      const panel = pdf.locator('.ai-chat')

      // Earlier conversation (2 records) is present and collapsed behind a toggle
      const earlier = pdf.locator('.ai-history-sep')
      await expect(earlier).toBeVisible()
      await expect(earlier).toHaveText(/Earlier conversation \(2\)/)
      await expect(pdf.locator('.ai-msg-historic')).toHaveCount(2)
      await expect(pdf.locator('.ai-msg-historic').first()).toContainText('old question')
      await expect(panel).toContainText('new question')

      // The stopped turn keeps its partial text, its completed action and its status
      await expect(pdf.locator('.ai-msg-status')).toHaveText('Stopped')
      await expect(panel).toContainText('partial answer')
      // the answer body is the model's own output: the stop is stated once, by the
      // status line, not duplicated inside (and saved into) the reply text
      await expect(pdf.locator('.ai-chat > .ai-msg-assistant .ai-md')).toHaveText('partial answer')
      await expect(panel).toContainText('Edited page 1')
      // ...and it is idle: restoring a transcript never starts a request (no key is
      // configured here, so any provider call would be impossible anyway)
      await expect(pdf.locator('.ai-typing')).toHaveCount(0)

      // The earlier block toggles, and the records stay reachable
      await earlier.click()
      await expect(pdf.locator('.ai-msg-historic')).toHaveCount(0)
      await expect(earlier).toHaveAttribute('aria-expanded', 'false')
      await earlier.click()
      await expect(pdf.locator('.ai-msg-historic')).toHaveCount(2)

      // New chat: the visible conversation moves into the earlier block (nothing
      // is deleted) and the model context starts fresh.
      await pdf.locator('.ai-panel-header-actions button[aria-label="New chat"]').click()
      await expect(earlier).toHaveText(/Earlier conversation \(4\)/)
      await expect(pdf.locator('.ai-chat > .ai-msg')).toHaveCount(0)

      // The boundary is durable: the next conversation starts after seq 3.
      await expect
        .poll(async () => {
          const index = JSON.parse(
            await readFile(join(userDataDir, 'projects', 'index.json'), 'utf8'),
          ) as { chatBoundaryByChatId?: Record<string, number> }
          return index.chatBoundaryByChatId?.[chatId]
        })
        .toBe(4)
    } finally {
      await closeReader(launched)
    }
  })
})
