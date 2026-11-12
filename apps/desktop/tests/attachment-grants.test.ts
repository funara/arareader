import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  pick: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  webContents: { getAllWebContents: () => [] },
}))
vi.mock('@arareader/electron-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arareader/electron-utils')>()),
  showOpenDialogWithMemory: electron.pick,
}))

import { registerAiBridge } from '../src/main/ai-bridge'

const sender = (id: number) => ({
  id,
  isDestroyed: () => false,
  once: vi.fn((_event: string, _handler: () => void) => {}),
})
type Result = {
  ok: boolean
  text: string
  base64: string
  accepted: unknown[]
  rejected: string[]
  ungranted: string[]
}
const invoke = (
  channel: string,
  view: ReturnType<typeof sender>,
  ...args: unknown[]
): Promise<Result> => {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return Promise.resolve(handler({ sender: view }, ...args)) as Promise<Result>
}

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'arareader-attachment-test-'))
  registerAiBridge()
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('attachment grants', () => {
  it('does not let an unselected path self-grant and read, but permits a picked file only in its view', async () => {
    const path = join(dir, 'synthetic.txt')
    await writeFile(path, 'synthetic content')
    const a = sender(71001)
    const b = sender(71002)
    expect((await invoke('files:read', a, path, 0, 100)).ok).toBe(false)
    const denied = await invoke('files:add', a, [path])
    expect(denied.accepted).toEqual([])
    expect(denied.ungranted).toEqual([path])
    expect((await invoke('files:read', a, path, 0, 100)).ok).toBe(false)
    electron.pick.mockResolvedValueOnce({ canceled: false, filePaths: [path] })
    expect((await invoke('files:pick', a)).accepted).toHaveLength(1)
    expect((await invoke('files:read', a, path, 0, 100)).text).toBe('synthetic content')
    expect((await invoke('files:read', b, path, 0, 100)).ok).toBe(false)
    expect((await invoke('files:add', a, [path])).accepted).toHaveLength(1)
    const destroy = a.once.mock.calls[0]?.[1] as (() => void) | undefined
    expect(destroy).toBeDefined()
    destroy?.()
    expect((await invoke('files:read', a, path, 0, 100)).ok).toBe(false)
    expect((await invoke('files:add', a, [path])).ungranted).toEqual([path])
  })

  it('grants only native-picker selections from mixed inputs and denies another view', async () => {
    const selected = join(dir, 'selected.txt')
    const unselected = join(dir, 'unselected.txt')
    const unsupported = join(dir, 'unsupported.bin')
    await Promise.all([
      writeFile(selected, 'selected synthetic content'),
      writeFile(unselected, 'unselected synthetic content'),
      writeFile(unsupported, 'unsupported synthetic content'),
    ])
    const a = sender(71005)
    const b = sender(71006)
    electron.pick.mockResolvedValueOnce({ canceled: false, filePaths: [unsupported, selected] })
    const result = await invoke('files:pick', a, 'reselect')
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected).toHaveLength(1)
    expect((await invoke('files:read', a, selected, 0, 100)).text).toBe(
      'selected synthetic content',
    )
    expect((await invoke('files:add', a, [unselected, unsupported])).ungranted).toEqual([
      unselected,
      unsupported,
    ])
    expect((await invoke('files:read', a, unselected, 0, 100)).ok).toBe(false)
    expect((await invoke('files:read', b, selected, 0, 100)).ok).toBe(false)
    expect((await invoke('files:add', b, [selected])).ungranted).toEqual([selected])
  })

  it('keeps image reads isolated, handles cancellation, and revalidates missing or oversized files', async () => {
    const path = join(dir, 'synthetic.png')
    await writeFile(path, Buffer.from([1, 2, 3]))
    const a = sender(71003)
    const b = sender(71004)
    electron.pick.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await invoke('files:pick', a)).toBeNull()
    expect((await invoke('files:read-image', a, path)).ok).toBe(false)
    electron.pick.mockResolvedValueOnce({ canceled: false, filePaths: [path] })
    expect((await invoke('files:pick', a)).accepted).toHaveLength(1)
    expect((await invoke('files:read-image', a, path)).base64).toBe('AQID')
    expect((await invoke('files:read-image', b, path)).ok).toBe(false)
    await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1))
    expect((await invoke('files:add', a, [path])).rejected).toHaveLength(1)
    expect((await invoke('files:read-image', a, path)).ok).toBe(false)
    await rm(path)
    expect((await invoke('files:add', a, [path])).rejected).toHaveLength(1)
  })
})
