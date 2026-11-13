import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userDataPath: '',
}))

vi.mock('electron', () => ({
  app: { getPath: () => electron.userDataPath },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  webContents: { getAllWebContents: () => [] },
}))

import { PROJECT_CHANNELS } from '../src/shared/ai-api'
import { registerAiBridge } from '../src/main/ai-bridge'

let dir: string

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return Promise.resolve(handler({ sender: {} }, ...args))
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'arareader-project-history-'))
  electron.userDataPath = dir
  registerAiBridge()
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('project history IPC Save As copy', () => {
  it('keeps the source mapping while copying its active history to the existing destination', async () => {
    const sourcePath = '/synthetic/source.pdf'
    const targetPath = '/synthetic/destination.pdf'
    const source = (await invoke(PROJECT_CHANNELS.resolveChat, {
      filePath: sourcePath,
    })) as { projectId: string; chatId: string; boundarySeq: number }
    const target = (await invoke(PROJECT_CHANNELS.resolveChat, {
      filePath: targetPath,
    })) as { projectId: string; chatId: string; boundarySeq: number }

    await invoke(PROJECT_CHANNELS.appendChat, {
      projectId: source.projectId,
      chatId: source.chatId,
      role: 'user',
      text: 'closed source question',
    })
    await invoke(PROJECT_CHANNELS.appendChat, {
      projectId: source.projectId,
      chatId: source.chatId,
      role: 'assistant',
      text: 'closed source answer',
    })
    const sourceBoundary = (await invoke(PROJECT_CHANNELS.startNewChat, {
      projectId: source.projectId,
      chatId: source.chatId,
    })) as { boundarySeq: number }
    await invoke(PROJECT_CHANNELS.appendChat, {
      projectId: source.projectId,
      chatId: source.chatId,
      role: 'user',
      text: 'active source question',
    })
    await invoke(PROJECT_CHANNELS.appendChat, {
      projectId: source.projectId,
      chatId: source.chatId,
      role: 'assistant',
      text: 'active source answer',
    })
    await invoke(PROJECT_CHANNELS.appendChat, {
      projectId: target.projectId,
      chatId: target.chatId,
      role: 'user',
      text: 'destination history',
    })

    const result = (await invoke(PROJECT_CHANNELS.rebindChat, {
      projectId: source.projectId,
      tempChatId: source.chatId,
      newFilePath: targetPath,
      copyToFile: true,
      copyOperationId: 'ipc-save-as-1',
    })) as { projectId: string; chatId: string; boundarySeq: number }

    expect(result).toMatchObject({
      projectId: target.projectId,
      chatId: target.chatId,
      boundarySeq: 1,
    })
    const reopenedSource = (await invoke(PROJECT_CHANNELS.resolveChat, {
      filePath: sourcePath,
    })) as { chatId: string }
    expect(reopenedSource.chatId).toBe(source.chatId)
    const sourceFile = join(dir, 'projects', source.projectId, 'chats', `${source.chatId}.jsonl`)
    const targetFile = join(dir, 'projects', target.projectId, 'chats', `${target.chatId}.jsonl`)
    await expect(readFile(sourceFile, 'utf8')).resolves.toContain('active source answer')
    await expect(readFile(targetFile, 'utf8')).resolves.toContain('destination history')
    const destinationHistory = await readFile(targetFile, 'utf8')
    expect(destinationHistory).toContain('active source answer')
    expect(destinationHistory).not.toContain('closed source question')

    // The destination's original history is earlier than the copied active session.
    expect(sourceBoundary.boundarySeq).toBe(2)
  })

  it('returns an unknown boundary on history failure so the panel can retry without failing the PDF save', async () => {
    const sourcePath = '/synthetic/retry-source.pdf'
    const targetPath = '/synthetic/retry-destination.pdf'
    const source = (await invoke(PROJECT_CHANNELS.resolveChat, {
      filePath: sourcePath,
    })) as { projectId: string; chatId: string }
    const target = (await invoke(PROJECT_CHANNELS.resolveChat, {
      filePath: targetPath,
    })) as { projectId: string; chatId: string }
    await invoke(PROJECT_CHANNELS.appendChat, {
      projectId: source.projectId,
      chatId: source.chatId,
      role: 'user',
      text: 'retryable source message',
    })
    await invoke(PROJECT_CHANNELS.appendChat, {
      projectId: target.projectId,
      chatId: target.chatId,
      role: 'user',
      text: 'existing destination message',
    })

    const blockedTemp = join(dir, 'projects', 'index.json.tmp')
    await mkdir(blockedTemp)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failed = (await invoke(PROJECT_CHANNELS.rebindChat, {
      projectId: source.projectId,
      tempChatId: source.chatId,
      newFilePath: targetPath,
      copyToFile: true,
      copyOperationId: 'ipc-save-as-retry',
    })) as { projectId: string; chatId: string; boundarySeq?: number }
    warn.mockRestore()
    expect(failed.boundarySeq).toBeUndefined()

    await rm(blockedTemp, { recursive: true, force: true })
    const recovered = (await invoke(PROJECT_CHANNELS.rebindChat, {
      projectId: source.projectId,
      tempChatId: source.chatId,
      newFilePath: targetPath,
      copyToFile: true,
      copyOperationId: 'ipc-save-as-retry',
    })) as { projectId: string; chatId: string; boundarySeq: number }
    expect(recovered.boundarySeq).toBe(1)
    const targetFile = join(dir, 'projects', target.projectId, 'chats', `${target.chatId}.jsonl`)
    const rows = (await readFile(targetFile, 'utf8')).trim().split('\n')
    expect(rows).toHaveLength(2)
    expect(rows.join('\n')).toContain('retryable source message')
  })
})
