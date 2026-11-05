import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { applySaveRequest } from '../src/main/save-pdf'
import {
  buildTextEdit,
  compileContentEdits,
  cropCanvasImage,
  displayBoxToPdf,
  extractPageImages,
  extractPageTextBlocks,
  imageFileToPng,
  renderSolidPatch,
  sampleCanvasColors,
  type EditableTextBlock,
  type ImageContentEdit,
  type RawTextItem,
  type TextContentEdit,
} from '../src/renderer/content-edit'
import type { SavePdfRequest } from '../src/shared/ipc'

/** 1×1 PNG: the bitmap every canvas mock returns, so compiled payloads stay valid PDFs */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const saveRequest = (over: Partial<SavePdfRequest> = {}): SavePdfRequest => ({
  path: '/tmp/content-edit.pdf',
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  ...over,
})

// ---------------------------------------------------------------------------------------------------
// Canvas mock: the browser 2d context is what jsdom does not provide, so sampling/cropping is checked
// against an explicit pixel buffer instead of a real renderer.
// ---------------------------------------------------------------------------------------------------

interface FakeCtx {
  fillStyle: string
  font: string
  textAlign: string
  textBaseline: string
  scale: () => void
  measureText: (text: string) => { width: number }
  fillRect: (x: number, y: number, w: number, h: number) => void
  fillText: () => void
  drawImage: (...args: unknown[]) => void
  getImageData: (x: number, y: number, w: number, h: number) => ImageData
}

let pixels: WeakMap<HTMLCanvasElement, Uint8ClampedArray>
let drawCalls: number[][]

/** White backing buffer per canvas, painted by the tests that need ink */
function bufferFor(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const existing = pixels.get(canvas)
  if (existing) return existing
  const count = canvas.width * canvas.height
  const buf = new Uint8ClampedArray(count * 4)
  for (let i = 0; i < count; i++) {
    buf[i * 4] = 255
    buf[i * 4 + 1] = 255
    buf[i * 4 + 2] = 255
    buf[i * 4 + 3] = 255
  }
  pixels.set(canvas, buf)
  return buf
}

function paintPixel(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  rgb: [number, number, number],
) {
  const buf = bufferFor(canvas)
  const i = (y * canvas.width + x) * 4
  buf[i] = rgb[0]
  buf[i + 1] = rgb[1]
  buf[i + 2] = rgb[2]
  buf[i + 3] = 255
}

function contextFor(canvas: HTMLCanvasElement): FakeCtx {
  return {
    fillStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    scale: () => {},
    measureText: (text: string) => ({ width: text.length * 5 }),
    fillRect: () => {},
    fillText: () => {},
    drawImage: (...args: unknown[]) => {
      drawCalls.push(args.filter((a): a is number => typeof a === 'number'))
    },
    getImageData: (x, y, w, h) => {
      const src = bufferFor(canvas)
      const out = new Uint8ClampedArray(w * h * 4)
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const si = ((y + row) * canvas.width + (x + col)) * 4
          const di = (row * w + col) * 4
          for (let k = 0; k < 4; k++) out[di + k] = src[si + k] ?? 255
        }
      }
      return { data: out, width: w, height: h } as unknown as ImageData
    },
  }
}

beforeEach(() => {
  pixels = new WeakMap()
  drawCalls = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return contextFor(this) as unknown as CanvasRenderingContext2D
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(`data:image/png;base64,${PNG}`)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------------------------------
// Text block grouping
// ---------------------------------------------------------------------------------------------------

/** One pdf.js text item; transform is [a, b, c, d, x, y] in PDF user space */
const item = (
  str: string,
  x: number,
  y: number,
  opts: { size?: number; width?: number; fontName?: string; height?: number } = {},
): RawTextItem => {
  const size = opts.size ?? 10
  return {
    str,
    width: opts.width ?? str.length * 5,
    height: opts.height ?? size,
    fontName: opts.fontName ?? 'g_d0_f1',
    transform: [size, 0, 0, size, x, y],
  }
}

describe('extractPageTextBlocks', () => {
  it('merges same-baseline fragments, adding a space, padded 1.5pt', () => {
    const blocks = extractPageTextBlocks(0, [
      item('Hello', 72, 700, { width: 27 }),
      item('World', 104, 700, { width: 30 }),
    ])
    expect(blocks).toEqual([
      {
        id: 't0-0',
        pageIndex: 0,
        text: 'Hello World',
        fontSize: 10,
        bold: false,
        italic: false,
        // x1-1.5, baseline-0.25·10-1.5, x2+1.5, baseline+height+1.5
        origRect: [70.5, 696, 135.5, 711.5],
      },
    ])
  })

  it('keeps fragments with no visible gap together and tolerates baseline jitter', () => {
    const blocks = extractPageTextBlocks(0, [
      item('Hel', 72, 700.5, { width: 15 }),
      item('lo', 87, 700, { width: 12 }),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toBe('Hello')
  })

  it('splits on a vertical jump', () => {
    const blocks = extractPageTextBlocks(0, [
      item('Top', 72, 700, { width: 20 }),
      item('Bottom', 72, 690, { width: 35 }),
    ])
    expect(blocks.map((b) => b.text)).toEqual(['Top', 'Bottom'])
    expect(blocks.map((b) => b.id)).toEqual(['t0-0', 't0-1'])
  })

  it('splits when the horizontal gap exceeds 2.5× the font size', () => {
    expect(
      extractPageTextBlocks(0, [
        item('Left', 72, 700, { width: 27 }),
        item('Right', 125, 700, { width: 30 }),
      ]).map((b) => b.text),
    ).toEqual(['Left', 'Right'])
    // one point tighter and the two fragments are the same line
    expect(
      extractPageTextBlocks(0, [
        item('Left', 72, 700, { width: 27 }),
        item('Right', 123, 700, { width: 30 }),
      ]).map((b) => b.text),
    ).toEqual(['Left Right'])
  })

  it('does not double a space the fragments already carry', () => {
    const blocks = extractPageTextBlocks(0, [
      item('Hello ', 72, 700, { width: 27 }),
      item('World', 104, 700, { width: 30 }),
    ])
    expect(blocks[0]!.text).toBe('Hello World')
  })

  it('drops whitespace-only, non-string, transform-less and marked-content items', () => {
    const blocks = extractPageTextBlocks(0, [
      item('   ', 72, 700, { width: 20 }),
      { str: 42, transform: [10, 0, 0, 10, 72, 700] },
      { str: 'no transform' },
      { type: 'beginMarkedContent' },
      item('Kept', 72, 700, { width: 20 }),
    ])
    expect(blocks.map((b) => b.text)).toEqual(['Kept'])
  })

  it('infers bold and italic from the style stack and the font name', () => {
    const blocks = extractPageTextBlocks(
      2,
      [
        item('Bold', 72, 700, { width: 20, fontName: 'F1' }),
        item('Italic', 72, 680, { width: 25, fontName: 'F2' }),
        item('Heavy', 72, 660, { width: 25, fontName: 'Roboto-Heavy' }),
        item('Plain', 72, 640, { width: 25, fontName: 'F3' }),
      ],
      {
        F1: { fontFamily: 'DejaVuSans-Bold' },
        F2: { fontFamily: 'LiberationSerif-Italic' },
        F3: { fontFamily: 'sans-serif' },
      },
    )
    expect(blocks.map((b) => [b.text, b.bold, b.italic])).toEqual([
      ['Bold', true, false],
      ['Italic', false, true],
      ['Heavy', true, false],
      ['Plain', false, false],
    ])
    // ids are indexed by page, then by the deterministic grouping order
    expect(blocks.map((b) => b.id)).toEqual(['t2-0', 't2-1', 't2-2', 't2-3'])
  })

  it('derives the font size from the transform and falls back to the item height', () => {
    const blocks = extractPageTextBlocks(0, [
      // 10pt glyphs rotated 90°: hypot(c, d) is still the effective size
      { str: 'Rotated', width: 35, height: 10, transform: [0, 10, -10, 0, 300, 400] },
      // no scale columns at all: the item height supplies the size
      { str: 'Sized', width: 25, height: 14, transform: [0, 0, 0, 0, 72, 500] },
    ])
    expect(blocks.map((b) => b.text)).toEqual(['Sized', 'Rotated'])
    expect(blocks.map((b) => b.fontSize)).toEqual([14, 10])
    expect(blocks[0]!.origRect).toEqual([70.5, 500 - 3.5 - 1.5, 97 + 1.5, 514 + 1.5])
  })
})

// ---------------------------------------------------------------------------------------------------
// Image discovery
// ---------------------------------------------------------------------------------------------------

/** Load saved bytes with the legacy build: the modern entry point expects a browser canvas */
async function pdfjsOperatorList(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false })
    .promise
  const page = await doc.getPage(1)
  return page.getOperatorList()
}

const near = (actual: number, expected: number, label: string) =>
  expect(Math.abs(actual - expected), `${label}: ${actual} ≉ ${expected}`).toBeLessThanOrEqual(0.5)

describe('extractPageImages', () => {
  it('puts a pdf-lib drawn image at its user-space rect', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const png = await doc.embedPng(PNG)
    page.drawImage(png, { x: 100, y: 200, width: 50, height: 80 })
    const ops = await pdfjsOperatorList(await doc.save({ useObjectStreams: false }))

    const images = extractPageImages(1, ops)
    expect(images).toHaveLength(1)
    expect(images[0]!.id).toBe('i1-0')
    expect(images[0]!.pageIndex).toBe(1)
    const [x1, y1, x2, y2] = images[0]!.origRect
    near(x1, 100, 'x1')
    near(y1, 200, 'y1')
    near(x2, 150, 'x2')
    near(y2, 280, 'y2')
  })

  it('follows save/transform/form nesting and drops sub-6pt paints', () => {
    const ops = {
      fnArray: [
        OPS.save,
        OPS.transform,
        OPS.paintFormXObjectBegin,
        OPS.transform,
        OPS.paintImageXObject,
        OPS.paintFormXObjectEnd,
        OPS.restore,
        OPS.save,
        OPS.transform,
        OPS.transform,
        OPS.paintImageMaskXObject,
        OPS.restore,
        OPS.transform,
        OPS.paintInlineImageXObject,
        OPS.paintImageXObjectRepeat,
      ],
      argsArray: [
        null,
        [2, 0, 0, 2, 10, 20],
        [
          [1, 0, 0, 1, 5, 5],
          [0, 0, 100, 100],
        ],
        [3, 0, 0, 4, 0, 0],
        ['img_0'],
        null,
        null,
        null,
        [1, 0, 0, 1, 200, 300],
        [5, 0, 0, 5, 0, 0],
        ['mask_5pt'],
        null,
        [7, 0, 0, 7, 50, 60],
        ['inline'],
        [
          [0, 0, 10, 0, 0, 10],
          [1, 0, 1, 0, 0, 0, 0, 1],
        ],
      ],
    }

    const images = extractPageImages(3, ops)
    // The 5pt mask is a page artifact, the repeat operator draws no single editable box
    expect(images.map((i) => i.id)).toEqual(['i3-0', 'i3-1'])
    expect(images[0]!.origRect).toEqual([20, 30, 26, 38])
    expect(images[1]!.origRect).toEqual([50, 60, 57, 67])
  })

  it('ignores paints whose CTM is not finite', () => {
    const images = extractPageImages(0, {
      fnArray: [OPS.transform, OPS.paintImageXObject, OPS.transform, OPS.paintImageXObject],
      argsArray: [
        [1e308, 0, 0, 1e308, 1e308, 1e308],
        ['overflow'],
        [Number.NaN, 0, 0, 1, 0, 0],
        ['nan'],
      ],
    })
    expect(images).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------------------------------

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
})

const fakeCanvas = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

describe('sampleCanvasColors', () => {
  it('keeps the never-fails fallbacks when there is no context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(sampleCanvasColors(fakeCanvas(20, 20), box(2, 2, 16, 16))).toEqual({
      bgColor: '#ffffff',
      color: '#14171f',
    })
  })

  it('takes the background from just outside the box and the ink from inside it', () => {
    const canvas = fakeCanvas(20, 20)
    paintPixel(canvas, 10, 10, [20, 23, 31])
    expect(sampleCanvasColors(canvas, box(4, 4, 12, 12))).toEqual({
      bgColor: '#ffffff',
      color: '#14171f',
    })
    // A tinted page: the border average is what the patch is filled with
    const tinted = fakeCanvas(20, 20)
    paintPixel(tinted, 10, 10, [0, 0, 0])
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        if (x === 10 && y === 10) continue
        paintPixel(tinted, x, y, [250, 247, 240])
      }
    }
    expect(sampleCanvasColors(tinted, box(4, 4, 12, 12))).toEqual({
      bgColor: '#faf7f0',
      color: '#000000',
    })
  })

  it('averages the four border samples and stays lowercase hex', () => {
    const canvas = fakeCanvas(10, 10)
    paintPixel(canvas, 4, 3, [255, 0, 0]) // left border sample sits at (x1-1, midY)
    expect(sampleCanvasColors(canvas, box(5, 4, 4, 4)).bgColor).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('cropCanvasImage', () => {
  it('crops the clamped device-pixel region and returns bare base64', () => {
    const canvas = fakeCanvas(20, 20)
    expect(cropCanvasImage(canvas, box(4, 4, 4, 4))).toBe(PNG)
    expect(drawCalls.at(-1)).toEqual([4, 4, 4, 4, 0, 0, 4, 4])
  })

  it('clamps a box that hangs off the canvas', () => {
    const canvas = fakeCanvas(20, 20)
    cropCanvasImage(canvas, box(-30, -30, 500, 500))
    expect(drawCalls.at(-1)).toEqual([0, 0, 20, 20, 0, 0, 20, 20])
  })

  it('scales by the device-pixel ratio and returns nothing for an empty region', () => {
    const canvas = fakeCanvas(40, 40)
    Object.defineProperty(canvas, 'clientWidth', { value: 20 })
    cropCanvasImage(canvas, box(4, 4, 4, 4))
    expect(drawCalls.at(-1)).toEqual([8, 8, 8, 8, 0, 0, 8, 8])

    drawCalls = []
    expect(cropCanvasImage(canvas, box(30, 30, 5, 5))).toBe('')
    expect(drawCalls).toEqual([])
  })

  it('returns an empty string when the context is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(cropCanvasImage(fakeCanvas(20, 20), box(0, 0, 10, 10))).toBe('')
  })
})

describe('renderSolidPatch', () => {
  it('caches one 1×1 bitmap per color', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    const first = renderSolidPatch('#123456')
    expect(first).toBe(PNG)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(renderSolidPatch('#123456')).toBe(first)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(renderSolidPatch('#654321')).toBe(PNG)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('displayBoxToPdf', () => {
  it('maps a display box through the page rotation and normalizes the rect', () => {
    expect(displayBoxToPdf({ pw: 612, ph: 792, rot: 0 }, box(10, 20, 30, 40))).toEqual([
      10, 732, 40, 772,
    ])
    expect(displayBoxToPdf({ pw: 612, ph: 792, rot: 90 }, box(10, 20, 30, 40))).toEqual([
      20, 10, 60, 40,
    ])
    expect(displayBoxToPdf({ pw: 612, ph: 792, rot: 180 }, box(10, 20, 30, 40))).toEqual([
      572, 20, 602, 60,
    ])
  })
})

// ---------------------------------------------------------------------------------------------------
// Text edit construction (shared by the Edit PDF overlay and the AI edit_text_block tool)
// ---------------------------------------------------------------------------------------------------

describe('buildTextEdit', () => {
  const geom = { pw: 612, ph: 792, rot: 0 }
  const block: EditableTextBlock = {
    id: 't0-0',
    pageIndex: 0,
    origRect: [70.5, 696, 135.5, 711.5],
    text: 'Hello World',
    fontSize: 10,
    bold: false,
    italic: false,
  }

  it('samples the page colors and anchors the bitmap on the block box', () => {
    const canvas = fakeCanvas(612, 792)
    // Dark ink inside the block's display box (left 70.5, top 80.5, 65 × 15.5): the replacement
    // text color is sampled from the page, not hardcoded
    for (let y = 85; y <= 91; y++) {
      for (let x = 95; x <= 105; x++) paintPixel(canvas, x, y, [0, 0, 0])
    }
    const edit = buildTextEdit(geom, block, canvas, 'Bye')
    expect(edit).not.toBeNull()
    const text = edit!
    expect(text.kind).toBe('text')
    expect(text.id).toBe('t0-0')
    expect(text.pageIndex).toBe(0)
    // The original box is kept for the whiteout patch; the bitmap is the new size
    expect(text.origRect).toEqual([70.5, 696, 135.5, 711.5])
    expect(text.text).toBe('Bye')
    expect(text.image).toBe(PNG)
    expect(text.bgColor).toBe('#ffffff')
    expect(text.color).toBe('#000000')
    // "Bye" at 10pt: 20 × 18pt, anchored at the block's top-left (70.5, 80.5 in display space)
    expect(text.rect).toEqual([70.5, 693.5, 90.5, 711.5])
  })

  it('falls back to a white page and dark ink when the canvas is unavailable', () => {
    const edit = buildTextEdit(geom, block, null, 'Bye')!
    expect(edit.bgColor).toBe('#ffffff')
    expect(edit.color).toBe('#14171f')
    // Same anchor, so a missing canvas changes colors only
    expect(edit.rect).toEqual([70.5, 693.5, 90.5, 711.5])
  })

  it('honours an explicit anchor, style overrides and page rotation', () => {
    const edit = buildTextEdit({ pw: 612, ph: 792, rot: 90 }, block, null, 'Bye', {
      at: box(100, 200, 1, 1),
      fontSize: 20,
      bold: true,
      italic: true,
    })!
    expect(edit.fontSize).toBe(20)
    expect(edit.bold).toBe(true)
    expect(edit.italic).toBe(true)
    // 90° display → PDF swaps axes: the anchor (100, 200) becomes (200, 100)
    expect(edit.rect[0]).toBe(200)
    expect(edit.rect[1]).toBe(100)
    // "Bye" at 20pt renders 25 × 36pt; the rotated rect carries the swapped extents
    expect(edit.rect[2] - edit.rect[0]).toBe(36)
    expect(edit.rect[3] - edit.rect[1]).toBe(25)
  })

  it('returns null when the replacement renders to nothing', () => {
    expect(buildTextEdit(geom, block, null, '   ')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------------------------------

const textEdit = (over: Partial<TextContentEdit> = {}): TextContentEdit => ({
  kind: 'text',
  id: 't0-0',
  pageIndex: 0,
  origRect: [70.5, 696, 135.5, 711.5],
  rect: [70.5, 696, 135.5, 711.5],
  bgColor: '#faf7f0',
  text: 'Hello World',
  fontSize: 10,
  bold: false,
  italic: false,
  color: '#14171f',
  image: PNG,
  ...over,
})

const imageEdit = (over: Partial<ImageContentEdit> = {}): ImageContentEdit => ({
  kind: 'image',
  id: 'i0-0',
  pageIndex: 0,
  origRect: [100, 200, 150, 280],
  rect: [100, 200, 150, 280],
  bgColor: '#ffffff',
  image: PNG,
  ...over,
})

describe('compileContentEdits', () => {
  it('turns a text edit into a patch stamp plus a FreeText drawing', () => {
    const { stamps, drawings } = compileContentEdits([textEdit()])
    expect(stamps).toEqual([{ pageIndex: 0, image: PNG, rect: [70.5, 696, 135.5, 711.5] }])
    expect(drawings).toEqual([
      {
        kind: 'freetext',
        pageIndex: 0,
        image: PNG,
        rect: [70.5, 696, 135.5, 711.5],
        contents: 'Hello World',
      },
    ])
  })

  it('covers deleted text with the patch only', () => {
    const { stamps, drawings } = compileContentEdits([textEdit({ text: '', image: '' })])
    expect(stamps).toHaveLength(1)
    expect(stamps[0]!.rect).toEqual([70.5, 696, 135.5, 711.5])
    expect(drawings).toEqual([])
  })

  it('draws a moved image over its patch, upright', () => {
    const moved = imageEdit({ rect: [300, 400, 375, 520] })
    const { stamps, drawings } = compileContentEdits([moved])
    expect(stamps).toHaveLength(2)
    // patches come first so the moved image is never covered by its own whiteout
    expect(stamps[0]).toEqual({ pageIndex: 0, image: PNG, rect: [100, 200, 150, 280] })
    expect(stamps[1]).toEqual({
      pageIndex: 0,
      image: PNG,
      rect: [300, 400, 375, 520],
      upright: true,
    })
    expect(drawings).toEqual([])
  })

  it('leaves only the patch for a deleted image', () => {
    const { stamps, drawings } = compileContentEdits([imageEdit({ image: '' })])
    expect(stamps).toHaveLength(1)
    expect(stamps[0]!.image).toBe(PNG)
    expect(drawings).toEqual([])
  })

  it('keeps patches ahead of every visible replacement', () => {
    const { stamps, drawings } = compileContentEdits([
      textEdit({ id: 't1-0', pageIndex: 1 }),
      imageEdit({ id: 'i0-0' }),
    ])
    expect(stamps.map((s) => s.pageIndex)).toEqual([1, 0, 0])
    expect(stamps[0]!.rect).toEqual([70.5, 696, 135.5, 711.5])
    expect(stamps[1]!.rect).toEqual([100, 200, 150, 280])
    expect(stamps[2]!.rect).toEqual([100, 200, 150, 280])
    expect(drawings).toHaveLength(1)
    expect(drawings[0]!.pageIndex).toBe(1)
  })

  it('drops an edit whose whiteout cannot be rasterized, keeping the rest of the save', () => {
    // Without a 2d context the patch is '' and pdf-lib refuses to embed it: shipping it anyway
    // would fail the save for every edit, so that one edit is left as it was on the page
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementationOnce(() => null)
    const { stamps, drawings } = compileContentEdits([
      textEdit({ id: 't0-0', bgColor: '#101010' }),
      textEdit({ id: 't0-1', bgColor: '#202020' }),
    ])
    expect(stamps).toEqual([{ pageIndex: 0, image: PNG, rect: [70.5, 696, 135.5, 711.5] }])
    expect(drawings).toEqual([
      {
        kind: 'freetext',
        pageIndex: 0,
        image: PNG,
        rect: [70.5, 696, 135.5, 711.5],
        contents: 'Hello World',
      },
    ])
  })

  it('preserves additive edits with empty origRect and no bgColor, emitting no whiteout patch', () => {
    const dupImage: ImageContentEdit = {
      id: 'img-dup-1',
      pageIndex: 0,
      origRect: [0, 0, 0, 0],
      rect: [120, 220, 170, 300],
      bgColor: '',
      kind: 'image',
      image: PNG,
    }
    const { stamps, drawings } = compileContentEdits([dupImage])
    expect(stamps).toEqual([
      {
        pageIndex: 0,
        image: PNG,
        rect: [120, 220, 170, 300],
        upright: true,
      },
    ])
    expect(drawings).toEqual([])
  })
})

describe('compiled edits round-trip through the save pipeline', () => {
  type ParsedAnnot = {
    subtype: string
    rect: number[]
    hasAppearance: boolean
    contentsObj?: { str?: string }
  }

  async function saveAndParse(request: SavePdfRequest): Promise<ParsedAnnot[]> {
    const doc = await PDFDocument.create()
    doc.addPage([612, 792])
    const blank = await doc.save({ useObjectStreams: false })
    const saved = await applySaveRequest(new Uint8Array(blank), request)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(saved), useSystemFonts: false })
      .promise
    const page = await loaded.getPage(1)
    return (await page.getAnnotations()) as ParsedAnnot[]
  }

  it('writes FreeText /Contents for an edited text block', async () => {
    const { stamps, drawings } = compileContentEdits([textEdit()])
    const annots = await saveAndParse(saveRequest({ stamps, drawings }))

    const free = annots.find((a) => a.subtype === 'FreeText')
    expect(free).toBeDefined()
    // The replacement text lives in the annotation, not as page content: it is listable and
    // selectable in viewers that surface annotations, and the original ink is gone underneath.
    expect(free!.contentsObj?.str).toBe('Hello World')
    expect(free!.hasAppearance).toBe(true)
    expect(free!.rect).toEqual([70.5, 696, 135.5, 711.5])
    // The whiteout patch is embedded as an image stamp, never an annotation
    expect(annots.map((a) => a.subtype)).not.toContain('Stamp')
  })

  it('keeps a deleted text block invisible: only the whiteout patch is written', async () => {
    const { stamps, drawings } = compileContentEdits([textEdit({ text: '', image: '' })])
    const annots = await saveAndParse(saveRequest({ stamps, drawings }))
    expect(annots).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------
// Image files
// ---------------------------------------------------------------------------------------------------

describe('imageFileToPng', () => {
  interface UrlStatics {
    createObjectURL?: (blob: Blob) => string
    revokeObjectURL?: (url: string) => void
  }

  it('decodes a file into a PNG plus its natural size and revokes the blob URL', async () => {
    const url = URL as unknown as UrlStatics
    const original = { ...url }
    const create = vi.fn(() => 'blob:content-edit')
    const revoke = vi.fn()
    url.createObjectURL = create
    url.revokeObjectURL = revoke
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        naturalWidth = 6
        naturalHeight = 3
        set src(_value: string) {
          queueMicrotask(() => this.onload?.())
        }
      },
    )
    try {
      const png = await imageFileToPng(new File(['x'], 'pasted.png', { type: 'image/png' }))
      expect(png).toEqual({ image: PNG, width: 6, height: 3 })
      expect(create).toHaveBeenCalledTimes(1)
      expect(revoke).toHaveBeenCalledWith('blob:content-edit')
    } finally {
      url.createObjectURL = original.createObjectURL
      url.revokeObjectURL = original.revokeObjectURL
      vi.unstubAllGlobals()
    }
  })

  it('rejects and still revokes the URL when the image cannot be decoded', async () => {
    const url = URL as unknown as UrlStatics
    const original = { ...url }
    const revoke = vi.fn()
    url.createObjectURL = vi.fn(() => 'blob:broken')
    url.revokeObjectURL = revoke
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.())
        }
      },
    )
    try {
      await expect(imageFileToPng(new File(['x'], 'broken.png'))).rejects.toThrow(
        /could not decode image/,
      )
      expect(revoke).toHaveBeenCalledWith('blob:broken')
    } finally {
      url.createObjectURL = original.createObjectURL
      url.revokeObjectURL = original.revokeObjectURL
      vi.unstubAllGlobals()
    }
  })
})
