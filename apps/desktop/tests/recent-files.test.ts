import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electronUtils from '@arareader/electron-utils'
import {
  mergeRecentPath,
  normalizeRecentQuery,
  pageRecentPaths,
  readRecentPaths,
  recordRecentFile,
  removeRecentFiles,
  removeRecentPaths,
  statRecentEntries,
} from '../src/main/recent-files'

const originalAtomicWriteFile = electronUtils.atomicWriteFile

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('recent files', () => {
  let dir: string
  let recentFile: string
  let pdfA: string
  let pdfB: string
  let pdfC: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arareader-recent-'))
    recentFile = join(dir, 'recent.json')
    pdfA = join(dir, 'alpha.pdf')
    pdfB = join(dir, 'beta.pdf')
    pdfC = join(dir, 'gamma.pdf')
    await Promise.all([writeFile(pdfA, 'a'), writeFile(pdfB, 'bb'), writeFile(pdfC, 'ccc')])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('records newest first and dedupes by path', async () => {
    await recordRecentFile(recentFile, pdfA)
    await recordRecentFile(recentFile, pdfB)
    await recordRecentFile(recentFile, pdfA)

    expect(await readRecentPaths(recentFile)).toEqual([pdfA, pdfB])
  })

  it('serializes overlapping additions instead of losing a recent PDF', async () => {
    const firstWriteStarted = deferred()
    const allowFirstWrite = deferred()
    let writeCount = 0
    vi.spyOn(electronUtils, 'atomicWriteFile').mockImplementation(async (...args) => {
      writeCount++
      if (writeCount === 1) {
        firstWriteStarted.resolve()
        await allowFirstWrite.promise
      }
      await originalAtomicWriteFile(...args)
    })

    const first = recordRecentFile(recentFile, pdfA)
    await firstWriteStarted.promise
    const second = recordRecentFile(recentFile, pdfB)
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      expect(writeCount).toBe(1)
    } finally {
      allowFirstWrite.resolve()
      await Promise.allSettled([first, second])
    }

    expect(await readRecentPaths(recentFile)).toEqual([pdfB, pdfA])
  })

  it('serializes removal and addition so both recent-list mutations apply', async () => {
    await writeFile(recentFile, JSON.stringify([pdfA, pdfB]))
    const firstWriteStarted = deferred()
    const allowFirstWrite = deferred()
    let writeCount = 0
    vi.spyOn(electronUtils, 'atomicWriteFile').mockImplementation(async (...args) => {
      writeCount++
      if (writeCount === 1) {
        firstWriteStarted.resolve()
        await allowFirstWrite.promise
      }
      await originalAtomicWriteFile(...args)
    })

    const removal = removeRecentFiles(recentFile, [pdfB])
    await firstWriteStarted.promise
    const addition = recordRecentFile(recentFile, pdfC)
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      expect(writeCount).toBe(1)
    } finally {
      allowFirstWrite.resolve()
      await Promise.allSettled([removal, addition])
    }

    expect(await readRecentPaths(recentFile)).toEqual([pdfC, pdfA])
  })

  it('continues processing recent mutations after a write failure', async () => {
    vi.spyOn(electronUtils, 'atomicWriteFile')
      .mockRejectedValueOnce(new Error('injected recent write failure'))
      .mockImplementation((...args) => originalAtomicWriteFile(...args))

    await expect(recordRecentFile(recentFile, pdfA)).rejects.toThrow(
      'injected recent write failure',
    )
    await recordRecentFile(recentFile, pdfB)

    expect(await readRecentPaths(recentFile)).toEqual([pdfB])
  })

  it('caps the list at 100 entries, dropping the oldest', () => {
    let paths: string[] = []
    for (let i = 0; i < 101; i++) paths = mergeRecentPath(paths, `/docs/file-${i}.pdf`)

    expect(paths).toHaveLength(100)
    expect(paths[0]).toBe('/docs/file-100.pdf')
    expect(paths).not.toContain('/docs/file-0.pdf')
  })

  it('ignores non-PDF paths', async () => {
    expect(mergeRecentPath([pdfA], '/docs/notes.txt')).toEqual([pdfA])

    await recordRecentFile(recentFile, '/docs/notes.txt')
    expect(await readRecentPaths(recentFile)).toEqual([])
  })

  it('filters stored non-PDF entries and tolerates corrupt or missing files', async () => {
    await writeFile(recentFile, JSON.stringify([pdfA, '/docs/notes.txt', 42]))
    expect(await readRecentPaths(recentFile)).toEqual([pdfA])

    await writeFile(recentFile, '{not json')
    expect(await readRecentPaths(recentFile)).toEqual([])

    expect(await readRecentPaths(join(dir, 'missing.json'))).toEqual([])
  })

  it('removes matching entries without touching the files', async () => {
    await recordRecentFile(recentFile, pdfA)
    await recordRecentFile(recentFile, pdfB)
    await recordRecentFile(recentFile, pdfC)

    await removeRecentFiles(recentFile, [pdfB])

    expect(await readRecentPaths(recentFile)).toEqual([pdfC, pdfA])
    expect(removeRecentPaths([pdfA, pdfB], [pdfA])).toEqual([pdfB])
    await expect(readFile(pdfB, 'utf8')).resolves.toBe('bb')
  })

  it('stats existing paths only', async () => {
    const entries = await statRecentEntries([pdfB, join(dir, 'gone.pdf')])

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      path: pdfB,
      name: 'beta.pdf',
      ext: 'pdf',
      sizeBytes: 2,
    })
    expect(entries[0].mtimeMs).toBeGreaterThan(0)
  })

  it('pages over existing paths, newest first', async () => {
    await recordRecentFile(recentFile, pdfA)
    await recordRecentFile(recentFile, pdfB)
    await recordRecentFile(recentFile, pdfC)

    const page = await pageRecentPaths(await readRecentPaths(recentFile), { offset: 1, limit: 1 })
    expect(page.entries.map((entry) => entry.path)).toEqual([pdfB])
    expect(page.total).toBe(3)
    expect(page.totalAll).toBe(3)

    const empty = await pageRecentPaths([pdfA], { limit: 0 })
    expect(empty.entries).toEqual([])
    expect(empty.total).toBe(1)
  })

  it('clamps page queries', () => {
    expect(normalizeRecentQuery(undefined)).toEqual({ offset: 0, limit: 50 })
    expect(normalizeRecentQuery({ offset: -5, limit: -1 })).toEqual({ offset: 0, limit: 0 })
    expect(normalizeRecentQuery({ offset: 2.9, limit: 5000 })).toEqual({ offset: 2, limit: 200 })
  })
})
