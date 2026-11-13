import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PDF_SOURCE_CONFLICT_ERROR, PDF_SOURCE_VERSION_REQUIRED_ERROR } from '../shared/ipc'

export function pdfSourceVersion(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function assertPdfSourceVersion(bytes: Uint8Array, expected: string | undefined): void {
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new Error(PDF_SOURCE_VERSION_REQUIRED_ERROR)
  }
  if (pdfSourceVersion(bytes) !== expected) throw new Error(PDF_SOURCE_CONFLICT_ERROR)
}

export async function readPdfSourceAtVersion(
  path: string,
  expected: string | undefined,
): Promise<Buffer> {
  const bytes = await readFile(path)
  assertPdfSourceVersion(bytes, expected)
  return bytes
}

/** Final read-side check before atomicWriteFile stages bytes; a write during staging can still win before rename. */
export async function assertPdfFileAtVersion(path: string, expected: string | undefined) {
  await readPdfSourceAtVersion(path, expected)
}
