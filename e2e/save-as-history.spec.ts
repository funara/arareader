import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { expect, test } from '@playwright/test'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

function chatIdFor(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

async function seedTranscript(
  userDataDir: string,
  chatId: string,
  messages: Array<{ role: 'user' | 'assistant'; text: string }>,
): Promise<void> {
  const chatsDir = join(userDataDir, 'projects', 'default', 'chats')
  await mkdir(chatsDir, { recursive: true })
  await writeFile(
    join(chatsDir, `${chatId}.jsonl`),
    `${messages
      .map((message, seq) =>
        JSON.stringify({ seq, ts: `2024-01-01T00:00:0${seq}.000Z`, ...message }),
      )
      .join('\n')}\n`,
    'utf8',
  )
}

test('Save As over an existing PDF preserves both independent chat histories and boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arareader-save-as-history-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-save-as-history-profile-'))
  const sourcePath = join(dir, 'source.pdf')
  const targetPath = join(dir, 'destination.pdf')
  const sourceChatId = chatIdFor(sourcePath)
  const targetChatId = chatIdFor(targetPath)
  const sourcePdf = await PDFDocument.create()
  sourcePdf.addPage([612, 792])
  sourcePdf.addPage([612, 792])
  const targetPdf = await PDFDocument.create()
  targetPdf.addPage([612, 792])
  await Promise.all([
    writeFile(sourcePath, await sourcePdf.save()),
    writeFile(targetPath, await targetPdf.save()),
  ])
  await Promise.all([
    seedTranscript(userDataDir, sourceChatId, [
      { role: 'user', text: 'source earlier question' },
      { role: 'assistant', text: 'source earlier answer' },
      { role: 'user', text: 'source active question' },
      { role: 'assistant', text: 'source active answer' },
    ]),
    seedTranscript(userDataDir, targetChatId, [
      { role: 'user', text: 'destination earlier question' },
      { role: 'assistant', text: 'destination earlier answer' },
      { role: 'user', text: 'destination active question' },
      { role: 'assistant', text: 'destination active answer' },
    ]),
  ])
  await mkdir(join(userDataDir, 'projects', 'default'), { recursive: true })
  await Promise.all([
    writeFile(
      join(userDataDir, 'projects', 'index.json'),
      JSON.stringify(
        {
          projects: [],
          fileMap: { [sourcePath]: 'default', [targetPath]: 'default' },
          chatIdByPath: { [sourcePath]: sourceChatId, [targetPath]: targetChatId },
          chatBoundaryByChatId: { [sourceChatId]: 2, [targetChatId]: 2 },
        },
        null,
        2,
      ),
    ),
    writeFile(
      join(userDataDir, 'projects', 'default', 'project.json'),
      JSON.stringify({
        id: 'default',
        name: 'Default Project',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        files: [sourcePath, targetPath],
      }),
    ),
  ])

  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    launched = await launchApp({ openFile: sourcePath, userDataDir })
    const sourceView = await waitForPageWithUrl(launched.app, 'pdf/out')
    await expect(sourceView.locator('.ai-chat')).toContainText('source active question')
    await launched.app.evaluate(({ dialog }, output) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output })
    }, targetPath)
    await launched.app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === 'File')
      const item = file?.submenu?.items.find((entry) => entry.label === 'Save As…')
      if (!item?.click) throw new Error('Missing Save As menu item')
      Reflect.apply(item.click, item, [item, undefined, {}])
    })

    await expect
      .poll(async () => {
        try {
          return (await PDFDocument.load(await readFile(targetPath))).getPageCount()
        } catch {
          return 0
        }
      })
      .toBe(2)
    await expect(sourceView.locator('.ai-history-sep')).toHaveText(/Earlier conversation \(4\)/)
    await expect(sourceView.locator('.ai-msg-historic')).toHaveCount(4)
    await expect(sourceView.locator('.ai-chat')).toContainText('source active answer')

    await expect
      .poll(async () => {
        const index = JSON.parse(
          await readFile(join(userDataDir, 'projects', 'index.json'), 'utf8'),
        ) as {
          chatIdByPath?: Record<string, string>
          chatBoundaryByChatId?: Record<string, number>
        }
        return [
          index.chatIdByPath?.[sourcePath],
          index.chatIdByPath?.[targetPath],
          index.chatBoundaryByChatId?.[sourceChatId],
          index.chatBoundaryByChatId?.[targetChatId],
        ]
      })
      .toEqual([sourceChatId, targetChatId, 2, 4])

    const sourceRows = (
      await readFile(
        join(userDataDir, 'projects', 'default', 'chats', `${sourceChatId}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { text: string })
    const targetRows = (
      await readFile(
        join(userDataDir, 'projects', 'default', 'chats', `${targetChatId}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { text: string })
    expect(sourceRows.map((row) => row.text)).toEqual([
      'source earlier question',
      'source earlier answer',
      'source active question',
      'source active answer',
    ])
    expect(targetRows.map((row) => row.text)).toEqual([
      'destination earlier question',
      'destination earlier answer',
      'destination active question',
      'destination active answer',
      'source active question',
      'source active answer',
    ])
  } finally {
    if (launched) await closeReader(launched)
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})
