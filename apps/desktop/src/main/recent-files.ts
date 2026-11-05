import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { atomicWriteFile } from '@arareader/electron-utils'
import type { RecentEntry, RecentPage, RecentQuery } from '../shared/home-api'

/** most recent PDFs kept on disk (userData/recent.json) */
export const RECENT_LIMIT = 100
const RECENT_PAGE_DEFAULT = 50
const RECENT_PAGE_MAX = 200
const PDF_RE = /\.pdf$/i

/**
 * Comparison-only path identity: resolve + lowercase on win32.
 * Display strings (RecentEntry.path) keep the OS's casing.
 */
export function normalizePathKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPdfPath(path: string): boolean {
  return PDF_RE.test(path)
}

/** newest-first, deduped, PDF-only, capped: the list after opening `path` */
export function mergeRecentPath(paths: readonly string[], path: string): string[] {
  if (!isPdfPath(path)) return [...paths]
  const key = normalizePathKey(path)
  return [path, ...paths.filter((p) => normalizePathKey(p) !== key)].slice(0, RECENT_LIMIT)
}

/** the list after dropping every matching entry (whether or not the file still exists) */
export function removeRecentPaths(paths: readonly string[], targets: readonly string[]): string[] {
  const drop = new Set(targets.map(normalizePathKey))
  return paths.filter((path) => !drop.has(normalizePathKey(path)))
}

/** stored entries: a JSON array of PDF paths; a corrupt/missing file reads as empty */
export async function readRecentPaths(file: string): Promise<string[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((path): path is string => typeof path === 'string' && isPdfPath(path))
  } catch {
    return []
  }
}

async function writeRecentPaths(file: string, paths: readonly string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await atomicWriteFile(file, Buffer.from(JSON.stringify(paths, null, 2), 'utf8'))
}

/** move a PDF to the head of the recent list and persist it */
export async function recordRecentFile(file: string, path: string): Promise<void> {
  await writeRecentPaths(file, mergeRecentPath(await readRecentPaths(file), path))
}

/** drop entries from the recent list; the files on disk are untouched */
export async function removeRecentFiles(file: string, targets: readonly string[]): Promise<void> {
  await writeRecentPaths(file, removeRecentPaths(await readRecentPaths(file), targets))
}

/** stat the paths that still exist; missing files are skipped */
export async function statRecentEntries(paths: readonly string[]): Promise<RecentEntry[]> {
  const entries = await Promise.all(
    paths.map(async (path): Promise<RecentEntry | null> => {
      try {
        const info = await stat(path)
        return {
          path,
          name: basename(path),
          ext: extname(path).slice(1).toLowerCase(),
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
        }
      } catch {
        return null
      }
    }),
  )
  return entries.filter((entry): entry is RecentEntry => entry !== null)
}

export function normalizeRecentQuery(raw: unknown): { offset: number; limit: number } {
  const query = (raw ?? {}) as RecentQuery
  const offset =
    typeof query.offset === 'number' && Number.isFinite(query.offset)
      ? Math.max(0, Math.floor(query.offset))
      : 0
  const limit =
    typeof query.limit === 'number' && Number.isFinite(query.limit)
      ? Math.min(RECENT_PAGE_MAX, Math.max(0, Math.floor(query.limit)))
      : RECENT_PAGE_DEFAULT
  return { offset, limit }
}

/** page over the paths that still exist, preserving the source's newest-first order */
export async function pageRecentPaths(paths: readonly string[], raw: unknown): Promise<RecentPage> {
  const { offset, limit } = normalizeRecentQuery(raw)
  const all = await statRecentEntries(paths)
  return {
    entries: limit === 0 ? [] : all.slice(offset, offset + limit),
    total: all.length,
    totalAll: all.length,
  }
}

/** read + stat + page the persisted recent list */
export async function readRecentPage(file: string, raw?: unknown): Promise<RecentPage> {
  return pageRecentPaths(await readRecentPaths(file), raw)
}
