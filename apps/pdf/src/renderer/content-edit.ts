import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { DrawingInput, StampInput } from '../shared/ipc'
import type { PageGeom } from './annotations'
import { pdfRectToCss, viewToPdf } from './annotations'
import { renderTextBox } from './stamps'

/**
 * Direct text/image editing, the non-destructive way: discovery reads what pdf.js already
 * decoded (text items and the operator list), every edit is additive (a whiteout patch stamp
 * plus, when something stays visible, a bitmap stamp or a FreeText annotation). Nothing here
 * touches, re-encodes or rewrites the page's own content stream.
 */

/** PDF user space, y up: [x1, y1, x2, y2] */
export type Rect = [number, number, number, number]

/**
 * One `getTextContent()` item, kept loose: marked-content entries share the array but carry no
 * text, and pdf.js does not guarantee the optional fields.
 */
export interface RawTextItem {
  str?: unknown
  transform?: number[]
  width?: number
  height?: number
  fontName?: string
  /** Marked-content markers (includeMarkedContent) — present only so the union type stays assignable */
  type?: unknown
}
export interface TextStyle {
  fontFamily?: string
}

export interface EditableTextBlock {
  /** `t${pageIndex}-${outputIndex}` */
  id: string
  pageIndex: number
  /** PDF user space, y up, padded 1.5pt */
  origRect: Rect
  text: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline?: boolean
}

export interface EditablePageImage {
  /** `i${pageIndex}-${outputIndex}` */
  id: string
  pageIndex: number
  /** PDF user space bbox of the painted image */
  origRect: Rect
}

interface ContentEditBase {
  id: string
  pageIndex: number
  origRect: Rect
  /** current position (equal to origRect until moved) */
  rect: Rect
  /** sampled page background, hex */
  bgColor: string
}
export interface TextContentEdit extends ContentEditBase {
  kind: 'text'
  /** '' means deleted */
  text: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline?: boolean
  /** hex */
  color: string
  /** rasterized replacement, base64 PNG without the prefix; '' when deleted */
  image: string
}
export interface ImageContentEdit extends ContentEditBase {
  kind: 'image'
  /** cropped bitmap, base64 PNG without the prefix; '' when deleted */
  image: string
}
export type PageContentEdit = TextContentEdit | ImageContentEdit

/** Text rect padding, so ascenders and descenders are covered by the patch */
const PAD = 1.5
const FALLBACK_BG = '#ffffff'
const FALLBACK_FG = '#14171f'
/** Decorative artifacts (rules, bullets, borders) are not worth an editable box */
const MIN_IMAGE_PT = 6

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

interface TextFragment {
  str: string
  x1: number
  x2: number
  baseline: number
  fontSize: number
  /** line height, falling back to the font size */
  height: number
  bold: boolean
  italic: boolean
  /** horizontal gap to the previous fragment on the same line; 0 for a line's first fragment */
  gap: number
}

interface TextLine {
  fragments: TextFragment[]
  baseline: number
  fontSize: number
  lastX2: number
}

/**
 * Group `getTextContent()` fragments into editable lines.
 *
 * Fragments are in PDF user space (viewport rotation is not applied to text transforms), so the
 * result needs no unrotation here. Sorting by baseline puts a line's fragments next to each other,
 * which is why only the previous line has to be considered when merging.
 */
export function extractPageTextBlocks(
  pageIndex: number,
  items: readonly RawTextItem[],
  styles?: Record<string, TextStyle>,
): EditableTextBlock[] {
  const fragments: TextFragment[] = []
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue
    const t = item.transform
    if (!Array.isArray(t) || t.length < 6) continue
    // transform is [a, b, c, d, x, y]; the scale columns give the effective font size
    const x1 = t[4]
    const baseline = t[5]
    const fontSize =
      Math.hypot(t[2], t[3]) || (finite(item.height) && item.height > 0 ? item.height : 12)
    if (!finite(x1) || !finite(baseline) || !finite(fontSize) || fontSize <= 0) continue
    const width = finite(item.width) ? item.width : 0
    const fontName = typeof item.fontName === 'string' ? item.fontName : ''
    // pdf.js often normalizes embedded fonts to a generic family, so these flags are best-effort
    const probe = `${styles?.[fontName]?.fontFamily ?? ''} ${fontName}`
    fragments.push({
      str: item.str,
      x1,
      x2: x1 + width,
      baseline,
      fontSize,
      height: finite(item.height) && item.height > 0 ? item.height : fontSize,
      bold: /bold|black|semibold|demi|heavy/i.test(probe),
      italic: /italic|oblique/i.test(probe),
      gap: 0,
    })
  }

  fragments.sort((a, b) => b.baseline - a.baseline || a.x1 - b.x1)

  const lines: TextLine[] = []
  for (const frag of fragments) {
    const line = lines.at(-1)
    const fits =
      line !== undefined &&
      Math.abs(frag.baseline - line.baseline) < Math.max(frag.fontSize, line.fontSize) * 0.35 &&
      frag.x1 - line.lastX2 < frag.fontSize * 2.5
    if (line && fits) {
      frag.gap = frag.x1 - line.lastX2
      line.fragments.push(frag)
      line.lastX2 = Math.max(line.lastX2, frag.x2)
    } else {
      lines.push({
        fragments: [frag],
        baseline: frag.baseline,
        fontSize: frag.fontSize,
        lastX2: frag.x2,
      })
    }
  }

  return lines.map((line, index) => {
    let text = ''
    for (const frag of line.fragments) {
      // Words split into separate fragments come back without spaces; keep readable text
      const needsSpace =
        text !== '' && frag.gap > frag.fontSize * 0.2 && !/\s$/.test(text) && !/^\s/.test(frag.str)
      text += needsSpace ? ` ${frag.str}` : frag.str
    }
    const xs = line.fragments.map((f) => f.x1)
    const xe = line.fragments.map((f) => f.x2)
    const yBase = Math.min(...line.fragments.map((f) => f.baseline))
    const yTop = Math.max(...line.fragments.map((f) => f.baseline + f.height))
    return {
      id: `t${pageIndex}-${index}`,
      pageIndex,
      origRect: [
        Math.min(...xs) - PAD,
        yBase - line.fontSize * 0.25 - PAD,
        Math.max(...xe) + PAD,
        yTop + PAD,
      ],
      text,
      fontSize: line.fontSize,
      bold: line.fragments.some((f) => f.bold),
      italic: line.fragments.some((f) => f.italic),
    }
  })
}

/** Affine CTM as pdf.js encodes it: x' = a·x + c·y + e, y' = b·x + d·y + f */
type Affine = [number, number, number, number, number, number]

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

const isMatrix = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length >= 6 && v.slice(0, 6).every(finite)

/**
 * Concatenate `m` onto the CTM: the new matrix applies in the current space, then the old CTM
 * (form/image space → page space). This is the pdf.js `transform`/`paintFormXObjectBegin`
 * convention, verified against a pdf-lib `drawImage(x:100, y:200, w:50, h:80)` page whose
 * resolved box is [100, 200, 150, 280].
 */
function concatCtm(ctm: Affine, m: readonly number[]): Affine {
  const [a, b, c, d, e, f] = ctm
  const A = m[0]!
  const B = m[1]!
  const C = m[2]!
  const D = m[3]!
  const E = m[4]!
  const F = m[5]!
  return [
    a * A + c * B,
    b * A + d * B,
    a * C + c * D,
    b * C + d * D,
    a * E + c * F + e,
    b * E + d * F + f,
  ]
}

/** Bounding box of the unit square under the CTM; null when the result is not finite */
function unitSquareRect(ctm: Affine): Rect | null {
  const [a, b, c, d, e, f] = ctm
  const xs = [e, a + e, c + e, a + c + e]
  const ys = [f, b + f, d + f, b + d + f]
  if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/**
 * Discover the painted images of a page from its operator list.
 *
 * Every image paint maps the unit square through the CTM, so the resulting rect is the exact user
 * space box of the image as displayed — no need to decode the image itself. Operators we do not
 * track leave the CTM alone (pdf.js keeps `save`/`restore` around nested forms, which is what the
 * stack follows).
 */
export function extractPageImages(
  pageIndex: number,
  ops: { fnArray: readonly number[]; argsArray: readonly unknown[] },
): EditablePageImage[] {
  const out: EditablePageImage[] = []
  let ctm: Affine = IDENTITY
  const stack: Affine[] = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i]
    if (fn === OPS.save) {
      stack.push(ctm)
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY
    } else if (fn === OPS.transform) {
      if (isMatrix(args)) ctm = concatCtm(ctm, args)
    } else if (fn === OPS.paintFormXObjectBegin) {
      // pdf.js always brackets a form with save/restore; the form's matrix maps its own space
      stack.push(ctm)
      if (Array.isArray(args) && isMatrix(args[0])) ctm = concatCtm(ctm, args[0])
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? IDENTITY
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageMaskXObject
    ) {
      const rect = unitSquareRect(ctm)
      if (!rect || rect[2] - rect[0] < MIN_IMAGE_PT || rect[3] - rect[1] < MIN_IMAGE_PT) continue
      out.push({ id: `i${pageIndex}-${out.length}`, pageIndex, origRect: rect })
    }
  }
  return out
}

export interface CanvasBox {
  left: number
  top: number
  width: number
  height: number
}

interface DeviceBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** CSS pixel box → device pixel box, clamped to the canvas (ratio 1 while the canvas is unlaid out) */
function deviceBox(canvas: HTMLCanvasElement, cssRect: CanvasBox): DeviceBox {
  const ratio = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
  const left = cssRect.left * ratio
  const top = cssRect.top * ratio
  const right = (cssRect.left + cssRect.width) * ratio
  const bottom = (cssRect.top + cssRect.height) * ratio
  return {
    x1: clamp(Math.round(Math.min(left, right)), 0, canvas.width),
    y1: clamp(Math.round(Math.min(top, bottom)), 0, canvas.height),
    x2: clamp(Math.round(Math.max(left, right)), 0, canvas.width),
    y2: clamp(Math.round(Math.max(top, bottom)), 0, canvas.height),
  }
}

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`

/**
 * Sample the colors around and inside a box on the rendered page canvas: the page background from
 * the border just outside the box (so the block's own ink does not tint it) and the strongest
 * interior contrast for the text color. Both are needed to build a replacement that blends in.
 */
export function sampleCanvasColors(
  canvas: HTMLCanvasElement,
  cssRect: CanvasBox,
): { bgColor: string; color: string } {
  const fallback = { bgColor: FALLBACK_BG, color: FALLBACK_FG }
  const { x1, y1, x2, y2 } = deviceBox(canvas, cssRect)
  const w = canvas.width
  const h = canvas.height
  if (w <= 0 || h <= 0) return fallback
  const ctx = canvas.getContext('2d')
  if (!ctx) return fallback

  const midX = clamp(Math.floor((x1 + x2) / 2), 0, w - 1)
  const midY = clamp(Math.floor((y1 + y2) / 2), 0, h - 1)
  const border: [number, number][] = [
    [clamp(x1 - 1, 0, w - 1), midY],
    [clamp(x2, 0, w - 1), midY],
    [midX, clamp(y1 - 1, 0, h - 1)],
    [midX, clamp(y2, 0, h - 1)],
  ]

  // Coarse interior grid: enough probes to find the ink color, few enough to stay cheap
  const probes: [number, number][] = []
  const iw = x2 - x1
  const ih = y2 - y1
  if (iw > 0 && ih > 0) {
    const cols = Math.min(40, iw)
    const rows = Math.min(40, ih)
    for (let r = 0; r < rows; r++) {
      const py = clamp(y1 + Math.floor(((r + 0.5) * ih) / rows), y1, y2 - 1)
      for (let c = 0; c < cols; c++) {
        probes.push([clamp(x1 + Math.floor(((c + 0.5) * iw) / cols), x1, x2 - 1), py])
      }
    }
  }

  const points = [...border, ...probes]
  const minX = Math.min(...points.map((p) => p[0]))
  const minY = Math.min(...points.map((p) => p[1]))
  const regionW = Math.max(...points.map((p) => p[0])) - minX + 1
  const regionH = Math.max(...points.map((p) => p[1])) - minY + 1
  let data: Uint8ClampedArray
  try {
    // One read for all probes: per-pixel getImageData would stall on the GPU readback
    data = ctx.getImageData(minX, minY, regionW, regionH).data
  } catch {
    return fallback
  }
  if (!data || data.length < regionW * regionH * 4) return fallback
  const pixel = (x: number, y: number): [number, number, number] => {
    const i = ((y - minY) * regionW + (x - minX)) * 4
    return [data[i]!, data[i + 1]!, data[i + 2]!]
  }

  let sumR = 0
  let sumG = 0
  let sumB = 0
  for (const [x, y] of border) {
    const [r, g, b] = pixel(x, y)
    sumR += r
    sumG += g
    sumB += b
  }
  const bg: [number, number, number] = [
    sumR / border.length,
    sumG / border.length,
    sumB / border.length,
  ]

  let best: [number, number, number] | null = null
  let bestDist = -1
  for (const [x, y] of probes) {
    const rgb = pixel(x, y)
    const dist = (rgb[0] - bg[0]) ** 2 + (rgb[1] - bg[1]) ** 2 + (rgb[2] - bg[2]) ** 2
    if (dist > bestDist) {
      bestDist = dist
      best = rgb
    }
  }

  return {
    bgColor: hex(bg[0], bg[1], bg[2]),
    color: best ? hex(best[0], best[1], best[2]) : FALLBACK_FG,
  }
}

/**
 * Crop the rendered pixels of a box into a base64 PNG. Any PDF image (JPX, JBIG2, CMYK, soft
 * masks) is already decoded on the page canvas, so dragging/copying one needs no image decoder.
 */
export function cropCanvasImage(canvas: HTMLCanvasElement, cssRect: CanvasBox): string {
  const { x1, y1, x2, y2 } = deviceBox(canvas, cssRect)
  const w = x2 - x1
  const h = y2 - y1
  if (w <= 0 || h <= 0) return ''
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  if (!ctx) return ''
  ctx.drawImage(canvas, x1, y1, w, h, 0, 0, w, h)
  return out.toDataURL('image/png').split(',')[1] ?? ''
}

/** 1×1 solid PNGs, one per color: whiteout patches are shared, so they are rendered once */
const patchCache = new Map<string, string>()

export function renderSolidPatch(color: string): string {
  if (!color || color === 'transparent') return ''
  const cached = patchCache.get(color)
  if (cached !== undefined) return cached
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  // Not cached when the context is missing: a later call may still be able to render it
  if (!ctx) return ''
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const image = canvas.toDataURL('image/png').split(',')[1] ?? ''
  if (image) patchCache.set(color, image)
  return image
}

/** Displayed box (page CSS px, scale=1) → PDF user space rect */
export function displayBoxToPdf(geom: PageGeom, box: CanvasBox): Rect {
  const [ax, ay] = viewToPdf(geom, box.left, box.top)
  const [bx, by] = viewToPdf(geom, box.left + box.width, box.top + box.height)
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

/**
 * Text edit for one discovered block: colors sampled from the rendered page, the replacement
 * rasterized at `fontSize`, and the bitmap anchored (top-left) on `at` — the block's own box by
 * default. Shared by the Edit PDF overlay (dragging/typing) and the AI `edit_text_block` tool, so
 * both produce byte-identical edit shapes. Null when the text renders to nothing.
 */
export function buildTextEdit(
  geom: PageGeom,
  block: EditableTextBlock,
  canvas: HTMLCanvasElement | null,
  text: string,
  opts: {
    fontSize?: number
    bold?: boolean
    italic?: boolean
    underline?: boolean
    /** canvas sampling scale; 1 for offscreen renders */
    scale?: number
    /** display-space top-left anchor; defaults to the block's own box */
    at?: CanvasBox
  } = {},
): TextContentEdit | null {
  const fontSize = opts.fontSize ?? block.fontSize
  const bold = opts.bold ?? block.bold
  const italic = opts.italic ?? block.italic
  const underline = opts.underline ?? block.underline ?? false
  const colors = canvas
    ? sampleCanvasColors(canvas, pdfRectToCss(geom, block.origRect, opts.scale ?? 1))
    : { bgColor: FALLBACK_BG, color: FALLBACK_FG }
  const rendered = renderTextBox(text, fontSize, colors.color, {
    bold,
    italic,
    underline,
    bgColor: colors.bgColor,
  })
  if (!rendered) return null
  const anchor = opts.at ?? pdfRectToCss(geom, block.origRect, 1)
  return {
    id: block.id,
    pageIndex: block.pageIndex,
    origRect: block.origRect,
    // The bitmap is the new size: anchor its top-left where the block was or was dropped
    rect: displayBoxToPdf(geom, {
      left: anchor.left,
      top: anchor.top,
      width: rendered.width,
      height: rendered.height,
    }),
    bgColor: colors.bgColor,
    kind: 'text',
    text,
    fontSize,
    bold,
    italic,
    underline,
    color: colors.color,
    image: rendered.image,
  }
}

/**
 * Page edits → save payload. Every edit starts with a whiteout patch over its original rect (so
 * the original ink and the original image are both hidden), then whatever stays visible is drawn
 * on top: a moved/resized image as a stamp, a replacement text box as a FreeText annotation whose
 * /Contents keeps the text listable. Patches come first so a moved edit never covers itself.
 */
export function compileContentEdits(edits: readonly PageContentEdit[]): {
  stamps: StampInput[]
  drawings: DrawingInput[]
} {
  const stamps: StampInput[] = []
  const drawings: DrawingInput[] = []
  // An edit that covers an original region needs a whiteout patch.
  // A missing 2d context makes the patch '' and pdf-lib refuses to embed empty bytes, which would
  // fail the whole save. Dropping that edit leaves the page as it was and keeps every other edit.
  // Additive edits (origRect has zero area, e.g. duplicate images) do not require a whiteout patch.
  const validEdits = edits
    .map((edit) => {
      const hasOrig =
        edit.origRect && edit.origRect[2] > edit.origRect[0] && edit.origRect[3] > edit.origRect[1]
      const patch = hasOrig && edit.bgColor ? renderSolidPatch(edit.bgColor) : ''
      return { edit, hasOrig, patch }
    })
    .filter(({ hasOrig, patch }) => !hasOrig || patch !== '')

  for (const { edit, hasOrig, patch } of validEdits) {
    if (hasOrig && patch !== '') {
      stamps.push({
        pageIndex: edit.pageIndex,
        image: patch,
        rect: [...edit.origRect],
      })
    }
  }

  for (const { edit } of validEdits) {
    if (edit.kind === 'image' && edit.image) {
      // `upright`: the rect is what the user sees, so save-pdf counter-rotates against /Rotate
      stamps.push({
        pageIndex: edit.pageIndex,
        image: edit.image,
        rect: [...edit.rect],
        upright: true,
      })
    } else if (edit.kind === 'text' && edit.text && edit.image) {
      drawings.push({
        kind: 'freetext',
        pageIndex: edit.pageIndex,
        image: edit.image,
        rect: [...edit.rect],
        contents: edit.text,
      })
    }
  }
  return { stamps, drawings }
}

/** Decode any browser-readable image into a PNG bitmap plus its natural size */
export function imageFileToPng(
  file: File,
): Promise<{ image: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const width = img.naturalWidth
        const height = img.naturalHeight
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('2d canvas context unavailable')
        ctx.drawImage(img, 0, 0)
        resolve({ image: canvas.toDataURL('image/png').split(',')[1] ?? '', width, height })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`could not decode image: ${file.name}`))
    }
    img.src = url
  })
}
