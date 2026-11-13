import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@arareader/ai-provider'
import { AI_CHANNELS } from '../src/shared/ai-api'

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

import { registerAiBridge } from '../src/main/ai-bridge'

let dir: string
let settingsPath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'arareader-ai-settings-'))
  electron.userDataPath = dir
  settingsPath = join(dir, 'ai-settings.json')
  registerAiBridge()
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function saveSettings(): Promise<void> {
  const handler = electron.handlers.get(AI_CHANNELS.setSettings)
  if (!handler) throw new Error(`Missing handler: ${AI_CHANNELS.setSettings}`)
  const settings = defaultAiSettings()
  settings.providers.google.apiKey = 'synthetic-test-api-key'
  await handler({ sender: {} }, settings)
}

describe('AI settings file permissions', () => {
  it('creates and replaces credential settings with owner-only POSIX permissions', async () => {
    const previousUmask = process.platform === 'win32' ? undefined : process.umask(0o022)
    try {
      await saveSettings()
      expect(await readFile(settingsPath, 'utf-8')).toContain('synthetic-test-api-key')

      if (process.platform === 'win32') return
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600)

      await chmod(settingsPath, 0o644)
      await saveSettings()
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600)
    } finally {
      if (previousUmask !== undefined) process.umask(previousUmask)
    }
  })
})
