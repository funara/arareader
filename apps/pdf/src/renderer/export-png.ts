interface PngPage<TViewport extends { width: number; height: number }> {
  rotate: number
  getViewport(options: { scale: number; rotation: number }): TViewport
  render(options: { canvas: HTMLCanvasElement; viewport: TViewport }): { promise: Promise<unknown> }
}

interface PngDocument<TViewport extends { width: number; height: number }> {
  getPage(pageNumber: number): Promise<PngPage<TViewport>>
}

/** Render and hand off one page at a time; the caller must await each write before the next render. */
export async function exportPagesAsPng<TViewport extends { width: number; height: number }>(
  doc: PngDocument<TViewport>,
  pageIndices: readonly number[],
  rotationForPage: (pageIndex: number, pageRotation: number) => number,
  writePage: (index: number, base64: string) => Promise<void>,
): Promise<void> {
  const canvas = document.createElement('canvas')
  try {
    for (const [index, pageIndex] of pageIndices.entries()) {
      const page = await doc.getPage(pageIndex + 1)
      const viewport = page.getViewport({
        scale: 150 / 72,
        rotation: rotationForPage(pageIndex, page.rotate) % 360,
      })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      await page.render({ canvas, viewport }).promise
      const base64 = canvas.toDataURL('image/png').split(',')[1] ?? ''
      await writePage(index, base64)
      canvas.width = 0
      canvas.height = 0
    }
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}
