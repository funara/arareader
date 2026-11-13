import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import JSZip from 'jszip'

const MAX_OFFICE_ARCHIVE_ENTRIES = 10_000
const MAX_OFFICE_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_OFFICE_ARCHIVE_BYTES = 64 * 1024 * 1024

type OfficeFormat = 'pptx' | 'xlsx'
// JSZip hides lazy compressed bytes in its runtime object; Node zlib lets us stop at actual byte limits.
type ZipEntryData = {
  compressedContent: Uint8Array
  compression: { magic: string }
  uncompressedSize: number
}
type ZipObjectWithData = JSZip.JSZipObject & { _data?: ZipEntryData }

/** Check actual expansion before a parser can accumulate XML text. */
export async function loadOfficeArchive(bytes: Uint8Array, format: OfficeFormat): Promise<JSZip> {
  const zip = await JSZip.loadAsync(bytes)
  const archiveEntries = Object.values(zip.files)
  if (archiveEntries.length > MAX_OFFICE_ARCHIVE_ENTRIES) {
    throw new Error(
      `${format} rejected: archive has ${archiveEntries.length} entries (limit ${MAX_OFFICE_ARCHIVE_ENTRIES})`,
    )
  }
  const files = archiveEntries.filter((file) => !file.dir)

  // Declared sizes reject ordinary bombs early; streamed output enforces the same limits if falsified.
  const entries = files.map((file) => {
    const data = (file as ZipObjectWithData)._data
    if (!data) throw new Error(`Invalid ${format}: missing compressed data for ${file.name}`)
    return { file, data }
  })
  let declaredTotal = 0
  for (const { file, data } of entries) {
    if (data.uncompressedSize > MAX_OFFICE_ENTRY_BYTES) {
      throw new Error(
        `${format} rejected: entry ${file.name} declares ${data.uncompressedSize} uncompressed bytes ` +
          `(limit ${MAX_OFFICE_ENTRY_BYTES})`,
      )
    }
    declaredTotal += data.uncompressedSize
    if (declaredTotal > MAX_OFFICE_ARCHIVE_BYTES) {
      throw new Error(
        `${format} rejected: declared total uncompressed data exceeds the ${MAX_OFFICE_ARCHIVE_BYTES} byte limit`,
      )
    }
  }

  let totalBytes = 0
  for (const { file, data } of entries) {
    totalBytes += await countInflatedBytes(file, data, format, totalBytes)
  }
  return zip
}

function countInflatedBytes(
  file: JSZip.JSZipObject,
  data: ZipEntryData,
  format: OfficeFormat,
  totalBeforeEntry: number,
): Promise<number> {
  const compressed = data.compressedContent
  const input = Readable.from([
    Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength),
  ])
  const output = data.compression.magic === '\x00\x00' ? input : input.pipe(createInflateRaw())
  let entryBytes = 0
  let settled = false

  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      input.destroy()
      if (output !== input) output.destroy()
      reject(error)
    }

    input.on('error', fail)
    output
      .on('data', (chunk: Buffer) => {
        const nextEntryBytes = entryBytes + chunk.byteLength
        if (nextEntryBytes > MAX_OFFICE_ENTRY_BYTES) {
          fail(
            new Error(
              `${format} rejected: entry ${file.name} exceeds the ${MAX_OFFICE_ENTRY_BYTES} byte limit`,
            ),
          )
          return
        }
        if (totalBeforeEntry + nextEntryBytes > MAX_OFFICE_ARCHIVE_BYTES) {
          fail(
            new Error(
              `${format} rejected: total uncompressed data exceeds the ${MAX_OFFICE_ARCHIVE_BYTES} byte limit`,
            ),
          )
          return
        }
        entryBytes = nextEntryBytes
      })
      .on('error', fail)
      .on('end', () => {
        if (settled) return
        if (entryBytes !== data.uncompressedSize) {
          fail(new Error('Bug : uncompressed data size mismatch'))
          return
        }
        settled = true
        resolve(entryBytes)
      })

    if (output === input) input.resume()
  })
}
