import { PDFDocument } from 'pdf-lib'

/** A4 portrait, one empty page; metadata keeps the first Save As title sensible. */
export async function createBlankPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([595.28, 841.89])
  doc.setTitle('Untitled')
  doc.setProducer('ARAReader')
  doc.setCreator('ARAReader')
  return doc.save()
}
