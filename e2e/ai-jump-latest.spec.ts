import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { test, expect } from '@playwright/test'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

/**
 * R6: a long restored conversation opens on its newest message, offers a
 * keyboard-operable "Jump to latest" only while the reader is away from the
 * bottom, and returns to the end when activated.
 *
 * The transcript is seeded on disk, so opening the PDF restores enough history
 * to overflow the panel without any provider being configured.
 */

function chatIdFor(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

test.describe('pdf ai navigation', () => {
  test('a long conversation opens at the newest message and jumps back to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-ai-jump-'))
    const pdfPath = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    document.addPage([612, 792])
    await writeFile(pdfPath, await document.save())

    const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-ai-jump-profile-'))
    const chatId = chatIdFor(pdfPath)
    const chatsDir = join(userDataDir, 'projects', 'default', 'chats')
    await mkdir(chatsDir, { recursive: true })
    // 20 question/answer pairs: far more than one panel height
    const records = Array.from({ length: 20 }, (_, i) => [
      { seq: i * 2, ts: '2024-01-01T00:00:00.000Z', role: 'user', text: `question ${i}` },
      {
        seq: i * 2 + 1,
        ts: '2024-01-01T00:00:01.000Z',
        role: 'assistant',
        text: `answer ${i}\n\nSecond line of answer ${i}.`,
      },
    ]).flat()
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
        },
        null,
        2,
      ),
      'utf8',
    )
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
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      const chat = pdf.locator('.ai-chat')
      await expect(chat).toContainText('answer 19')

      // Keyboard order follows the panel controls in both directions.
      const splitter = pdf.getByRole('separator', { name: 'Resize assistant panel' })
      const newChat = pdf.getByRole('button', { name: 'New chat' })
      const collapse = pdf.getByRole('button', { name: 'Collapse panel' })
      await splitter.focus()
      await pdf.keyboard.press('Tab')
      await expect(newChat).toBeFocused()
      await pdf.keyboard.press('Tab')
      await expect(collapse).toBeFocused()
      await pdf.keyboard.press('Shift+Tab')
      await expect(newChat).toBeFocused()
      await expect(newChat).toHaveCSS('outline-style', 'solid')

      // Restored history opens on the newest message, so no jump control yet
      const atBottom = (): Promise<boolean> =>
        chat.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 8,
        ) as Promise<boolean>
      await expect.poll(atBottom).toBe(true)
      await expect(pdf.locator('.ai-jump-latest')).toHaveCount(0)

      // Reading older messages offers the control; it appears without stealing focus
      await chat.evaluate((el) => el.scrollTo({ top: 0 }))
      const jump = pdf.locator('.ai-jump-latest')
      await expect(jump).toBeVisible()
      await expect(jump).toHaveText('Jump to latest')

      // At the 280 px minimum the control reserves scroll padding instead of
      // covering the newest message, and stays inside the panel.
      const resizer = pdf.locator('.ai-panel-resizer')
      await resizer.focus()
      await pdf.keyboard.press('Home')
      await expect.poll(async () => Number(await resizer.getAttribute('aria-valuenow'))).toBe(280)
      await chat.evaluate((el) => el.scrollTo({ top: 0 }))
      await expect(jump).toBeVisible()
      const geometry = await chat.evaluate((el) => {
        const button = document.querySelector('.ai-jump-latest') as HTMLElement
        const chatBox = el.getBoundingClientRect()
        const buttonBox = button.getBoundingClientRect()
        return {
          paddingBottom: getComputedStyle(el).paddingBottom,
          inside: buttonBox.left >= chatBox.left && buttonBox.right <= chatBox.right,
          fits: buttonBox.width <= chatBox.width - 24 + 1,
        }
      })
      expect(geometry.paddingBottom).toBe('46px')
      expect(geometry.inside).toBe(true)
      expect(geometry.fits).toBe(true)

      // 200% page zoom: the control still fits the chat column (no clipping)
      await pdf.evaluate(() => {
        document.body.style.zoom = '2'
      })
      await chat.evaluate((el) => el.scrollTo({ top: 0 }))
      await expect(jump).toBeVisible()
      const zoomGeometry = await chat.evaluate((el) => {
        const button = document.querySelector('.ai-jump-latest') as HTMLElement
        const chatBox = el.getBoundingClientRect()
        const buttonBox = button.getBoundingClientRect()
        return { inside: buttonBox.left >= chatBox.left && buttonBox.right <= chatBox.right }
      })
      expect(zoomGeometry.inside).toBe(true)
      await pdf.evaluate(() => {
        document.body.style.zoom = ''
      })

      // Reduced motion: no smooth transition is used (the jump is still instant)
      await pdf.emulateMedia({ reducedMotion: 'reduce' })
      await expect
        .poll(async () => jump.evaluate((el) => getComputedStyle(el).transitionDuration))
        .toBe('0s')

      // Keyboard activation returns to the end and hides the control
      await jump.focus()
      await pdf.keyboard.press('Enter')
      await expect.poll(atBottom, { timeout: 10_000 }).toBe(true)
      await expect(jump).toHaveCount(0)
      await pdf.emulateMedia({ reducedMotion: 'no-preference' })
    } finally {
      await closeReader(launched)
    }
  })
})
