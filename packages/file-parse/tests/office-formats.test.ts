import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseFileToText, pptxToText, xlsxToText } from '../src/index'
import {
  buildDocxFixture,
  buildPptxFixture,
  buildXlsxFixture,
  writeFixture,
} from './helpers/fixtures'

describe('parseFileToText: docx', () => {
  it('extracts headings, paragraphs and tables', async () => {
    const path = writeFixture('report.docx', await buildDocxFixture())
    const result = await parseFileToText(path)
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('text')
    expect(result.text).toContain('# Annual Report')
    expect(result.text).toContain('First paragraph hello docx')
    expect(result.text).toContain('Metric | Value')
    expect(result.text).toContain('Revenue | 100')
  })
})

describe('parseFileToText: pptx', () => {
  it('extracts one section per slide in numeric order', async () => {
    const path = writeFixture('deck.pptx', await buildPptxFixture())
    const result = await parseFileToText(path)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('## Slide 1\nProductIntro\nFirst slide subtitle')
    expect(result.text).toContain('## Slide 2\nMarket Analysis')
    // slide10 must sort after slide2 (numeric, not lexicographic)
    expect(result.text!.indexOf('## Slide 10')).toBeGreaterThan(result.text!.indexOf('## Slide 2'))
    expect(result.text).toContain('## Slide 10\nSummary Slide')
  })

  it('rejects actual per-entry expansion even when ZIP sizes under-report it', async () => {
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld/>')
    zip.file('ppt/media/unused.bin', 'x'.repeat(32 * 1024 * 1024))
    const archive = await buildArchiveWithLiedUncompressedSizes(zip, ['ppt/media/unused.bin'])

    await expect(pptxToText(archive)).rejects.toThrow(
      /pptx rejected: entry .* exceeds the 16777216 byte limit/,
    )
  })

  it('rejects too many ZIP entries, including directories, before inflating them', async () => {
    const zip = new JSZip()
    for (let i = 0; i < 10_000; i++) zip.file(`part-${i}.bin`, '')
    zip.folder('extra-directory')

    await expect(pptxToText(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      /pptx rejected: archive has 10001 entries \(limit 10000\)/,
    )
  })
})

describe('parseFileToText: xlsx', () => {
  it('extracts sheet name, shared/inline strings, numbers, booleans and empty columns', async () => {
    const path = writeFixture('table.xlsx', await buildXlsxFixture())
    const result = await parseFileToText(path)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('# Grades')
    expect(result.text).toContain('Name | Scores')
    // C2 is missing so the boolean in D2 lands in the 4th column
    expect(result.text).toContain('Alice | 95 |  | TRUE')
  })

  it('fails gracefully on a corrupt file', async () => {
    const path = writeFixture('broken.xlsx', Buffer.from('not a zip'))
    const result = await parseFileToText(path)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rejects actual aggregate expansion even when ZIP sizes under-report it', async () => {
    const zip = new JSZip()
    zip.file('xl/workbook.xml', '<workbook><sheets/></workbook>')
    for (let i = 0; i < 8; i++) zip.file(`unused/${i}.bin`, 'x'.repeat(13 * 1024 * 1024))
    const archive = await buildArchiveWithLiedUncompressedSizes(
      zip,
      Array.from({ length: 4 }, (_, i) => `unused/${i + 4}.bin`),
    )

    await expect(xlsxToText(archive)).rejects.toThrow(
      /xlsx rejected: total uncompressed data exceeds the 67108864 byte limit/,
    )
  })
})

async function buildArchiveWithLiedUncompressedSizes(
  zip: JSZip,
  names: string[],
): Promise<Uint8Array> {
  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
  })
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdSignature = 0x06054b50
  let eocd = bytes.length - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== eocdSignature) eocd--
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record missing')

  let offset = view.getUint32(eocd + 16, true)
  const entryCount = view.getUint16(eocd + 10, true)
  const namesToPatch = new Set(names)
  const decoder = new TextDecoder()
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50)
      throw new Error('Invalid ZIP central directory')
    const localOffset = view.getUint32(offset + 42, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (namesToPatch.has(name)) {
      view.setUint32(offset + 24, 1, true)
      view.setUint32(localOffset + 22, 1, true)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return bytes
}
