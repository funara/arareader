import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { createBlankPdfBytes } from '../src/main/blank-pdf'

describe('blank pdf', () => {
  it('starts with a PDF header', async () => {
    const bytes = await createBlankPdfBytes()
    expect(Buffer.from(bytes).toString('latin1', 0, 5)).toBe('%PDF-')
  })

  it('is one A4 portrait page with reader metadata', async () => {
    const doc = await PDFDocument.load(await createBlankPdfBytes())
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(595.28, 1)
    expect(height).toBeCloseTo(841.89, 1)
    expect(width).toBeLessThan(height)
    expect(doc.getTitle()).toBe('Untitled')
  })
})
