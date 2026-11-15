import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { DrawingInput, StampInput } from '../shared/ipc'
import type { PageGeom } from './annotations'
import { pdfRectToCss, viewToPdf } from './annotations'
import { renderTextBox, type TextFontFamily } from './stamps'

export type { TextFontFamily }

/** `original` keeps the detected PDF face; a generic family replaces it */
export type TextFontChoice = TextFontFamily | 'original'

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
  bold?: boolean
  italic?: boolean
  fontName?: string
  embeddedFont?: string
  isSerif?: boolean
  isMono?: boolean
}

export interface PageCommonObjsLike<T = unknown> {
  has(name: string): boolean
  get(name: string): T
}

interface PdfJsFontLike {
  name?: string
  bold?: boolean
  black?: boolean
  italic?: boolean
  isSerifFont?: boolean
  isMonospace?: boolean
  isType3Font?: boolean
  isSymbolicFont?: boolean
  missingFile?: boolean
  fallbackName?: string
  loadedName?: string
  data?: Uint8Array
  clearData?: () => void
  cssFontInfo?: {
    fontFamily?: string
    fontWeight?: string | number
    italicAngle?: string | number
  } | null
  systemFontInfo?: { css?: string; loadedName?: string; baseFontName?: string } | null
}

const KNOWN_FONT_NAMES: Record<string, string> = {
  timesnewroman: 'Times New Roman',
  timesnewromanps: 'Times New Roman',
  timesroman: 'Times New Roman',
  couriernew: 'Courier New',
  couriernewps: 'Courier New',
  helveticaneue: 'Helvetica Neue',
  segoeui: 'Segoe UI',
  microsoftyahei: 'Microsoft YaHei',
  pingfangsc: 'PingFang SC',
  opensans: 'Open Sans',
  notosans: 'Noto Sans',
  notoserif: 'Noto Serif',
  sourcesanspro: 'Source Sans Pro',
  sourcesans3: 'Source Sans 3',
  sourceserifpro: 'Source Serif Pro',
  plusjakartasans: 'Plus Jakarta Sans',
  dmsans: 'DM Sans',
  jetbrainsmono: 'JetBrains Mono',
  firacode: 'Fira Code',
  firasans: 'Fira Sans',
}

const GENERIC_OR_STD_FONT =
  /^(?:(?:sans-serif|serif|monospace|helvetica|times|courier)$|g_d\d+_[fs]\d+|invalidpdfjsfont)/i

/**
 * Extract a clean OS-matchable font family name from a PDF font name (e.g.
 * `"ABCDEF+Inter-Bold"` → `"Inter"`, `"TimesNewRomanPS-BoldMT"` → `"Times New Roman"`).
 * Returns `undefined` for generic CSS families, internal pdf.js IDs, and standard PDF aliases
 * that are better served by the cross-platform fallback stack.
 */
export function parsePdfFontName(rawName: string | undefined): string | undefined {
  if (!rawName) return undefined
  let name = rawName.trim()
  if (!name || GENERIC_OR_STD_FONT.test(name)) return undefined
  // Strip 6-letter PDF subset prefix (e.g. ABCDEF+Inter-Bold)
  name = name.replace(/^[A-Z]{6}\+/, '')
  // Drop style/encoding tags after comma or hyphen/underscore
  name = name.replace(/[,_].*$/, '')
  name = name.replace(
    /-(?:Regular|Normal|Roman|Book|Light|ExtraLight|UltraLight|Thin|Medium|SemiBold|Semibold|DemiBold|Demibold|Bold|ExtraBold|UltraBold|Black|Heavy|Italic|Oblique|BoldItalic|BoldOblique|SemiboldItalic|Condensed|Narrow|Expanded|PSMT|MT|PS).*$/i,
    '',
  )
  name = name.replace(/(?:BoldItalic|BoldOblique|Bold|Italic|Oblique)?(?:PSMT|MT|PS)$/i, '')
  name = name.trim()
  if (!name || GENERIC_OR_STD_FONT.test(name)) return undefined

  const compact = name.replace(/[\s_-]+/g, '').toLowerCase()
  if (KNOWN_FONT_NAMES[compact]) return KNOWN_FONT_NAMES[compact]
  if (GENERIC_OR_STD_FONT.test(compact)) return undefined

  // Split CamelCase (e.g. "DMSans" -> "DM Sans", "FiraCode" -> "Fira Code")
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
}

const embeddedFontCache = new WeakMap<object, Map<string, Promise<string | undefined>>>()
const STANDARD_LOADED_NAMES = new Set([
  'Helvetica',
  'Times',
  'Courier',
  'sans-serif',
  'serif',
  'monospace',
])

function ensureEmbeddedFontFace(
  fontObj: PdfJsFontLike,
  bold: boolean,
  italic: boolean,
): Promise<string | undefined> {
  const variantKey = `${bold ? '700' : '400'}:${italic ? 'italic' : 'normal'}`
  let byVariant = embeddedFontCache.get(fontObj)
  const cached = byVariant?.get(variantKey)
  if (cached) return cached

  const loadedName = fontObj.loadedName?.trim()
  if (!loadedName || STANDARD_LOADED_NAMES.has(loadedName)) return Promise.resolve(undefined)
  // Allow symbolic-flagged subset fonts (Chromium/Figma/Canva CID fonts set Symbolic even for Latin text)
  if (fontObj.isType3Font || fontObj.missingFile) return Promise.resolve(undefined)
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    return Promise.resolve(undefined)
  }
  if (!byVariant) {
    byVariant = new Map()
    embeddedFontCache.set(fontObj, byVariant)
  }

  // If upright normal weight, pdf.js already bound `loadedName` with { weight: 'normal', style: 'normal' }
  if (!bold && !italic) {
    fontObj.clearData?.()
    const resolved = Promise.resolve(loadedName)
    byVariant.set(variantKey, resolved)
    return resolved
  }
  if (!fontObj.data || fontObj.data.byteLength === 0) return Promise.resolve(undefined)

  // Register a weight/style-tagged alias so Chromium does not faux-bold an already-bold embedded face
  const alias = `ara-pdf-${loadedName}`
  const bytes = new Uint8Array(fontObj.data)
  const pending = (async () => {
    try {
      const face = new FontFace(alias, bytes, {
        weight: bold ? '700' : '400',
        style: italic ? 'italic' : 'normal',
      })
      document.fonts.add(face)
      await face.load()
      return alias
    } catch {
      return undefined
    } finally {
      fontObj.clearData?.()
    }
  })()
  byVariant.set(variantKey, pending)
  return pending
}

function buildEnrichedStyle(style: TextStyle, fontObj: PdfJsFontLike | null): TextStyle {
  const cssWeight = Number(fontObj?.cssFontInfo?.fontWeight)
  const italicAngle = Number(fontObj?.cssFontInfo?.italicAngle)
  const rawName =
    fontObj?.name ??
    fontObj?.cssFontInfo?.fontFamily ??
    fontObj?.systemFontInfo?.baseFontName ??
    style.fontFamily
  const bold =
    Boolean(style.bold) ||
    Boolean(fontObj?.bold || fontObj?.black) ||
    (Number.isFinite(cssWeight) && cssWeight >= 600) ||
    /bold|black|heavy|semibold|demibold|demi|extrabold|ultrabold/i.test(rawName ?? '')
  const italic =
    Boolean(style.italic) ||
    Boolean(fontObj?.italic) ||
    (Number.isFinite(italicAngle) && italicAngle !== 0) ||
    /italic|oblique/i.test(rawName ?? '')
  const familyParts = [
    style.fontFamily,
    fontObj?.name,
    fontObj?.cssFontInfo?.fontFamily,
    fontObj?.systemFontInfo?.baseFontName,
    fontObj?.systemFontInfo?.css,
    fontObj?.loadedName,
    fontObj?.fallbackName,
  ].filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  const fontName =
    style.fontName ??
    parsePdfFontName(fontObj?.name) ??
    parsePdfFontName(fontObj?.cssFontInfo?.fontFamily) ??
    parsePdfFontName(fontObj?.systemFontInfo?.baseFontName) ??
    parsePdfFontName(style.fontFamily)
  const isSerif = Boolean(style.isSerif || fontObj?.isSerifFont)
  const isMono = Boolean(style.isMono || fontObj?.isMonospace)
  const embeddedFont = style.embeddedFont
  return {
    fontFamily: familyParts.join(' ') || style.fontFamily,
    bold,
    italic,
    ...(fontName ? { fontName } : {}),
    ...(embeddedFont ? { embeddedFont } : {}),
    ...(isSerif ? { isSerif } : {}),
    ...(isMono ? { isMono } : {}),
  }
}

function readFontObj(commonObjs: PageCommonObjsLike, key: string): PdfJsFontLike | null {
  if (!commonObjs.has(key)) return null
  try {
    const raw = commonObjs.get(key)
    return raw && typeof raw === 'object' ? (raw as PdfJsFontLike) : null
  } catch {
    return null
  }
}

/**
 * Enrich pdf.js `getTextContent().styles` with font flags (`bold`, `italic`, `fontName`,
 * `isSerif`, `isMono`) from `page.commonObjs` populated by `getOperatorList()` / `render()`.
 */
export function enrichTextStyles(
  commonObjs: PageCommonObjsLike | null | undefined,
  styles?: Record<string, TextStyle>,
): Record<string, TextStyle> | undefined {
  if (!styles) return styles
  if (!commonObjs || typeof commonObjs.has !== 'function' || typeof commonObjs.get !== 'function') {
    return styles
  }
  const out: Record<string, TextStyle> = {}
  for (const [key, style] of Object.entries(styles)) {
    out[key] = buildEnrichedStyle(style, readFontObj(commonObjs, key))
  }
  return out
}

/**
 * Async variant of `enrichTextStyles` that also binds embedded PDF font faces into
 * `document.fonts` at their true weight/style so inline edits and rasterized saves match the PDF.
 */
export async function enrichTextStylesAsync(
  commonObjs: PageCommonObjsLike | null | undefined,
  styles?: Record<string, TextStyle>,
): Promise<Record<string, TextStyle> | undefined> {
  if (!styles) return styles
  if (!commonObjs || typeof commonObjs.has !== 'function' || typeof commonObjs.get !== 'function') {
    return styles
  }
  const entries = await Promise.all(
    Object.entries(styles).map(async ([key, style]) => {
      const fontObj = readFontObj(commonObjs, key)
      const base = buildEnrichedStyle(style, fontObj)
      const embeddedFont = fontObj
        ? await ensureEmbeddedFontFace(fontObj, Boolean(base.bold), Boolean(base.italic))
        : undefined
      return [key, embeddedFont ? { ...base, embeddedFont } : base] as const
    }),
  )
  return Object.fromEntries(entries)
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
  fontFamily?: TextFontFamily
  fontName?: string
  embeddedFont?: string
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
  fontFamily?: TextFontFamily
  fontName?: string
  embeddedFont?: string
  fontChoice?: TextFontChoice
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
  fontFamily: TextFontFamily
  fontName?: string
  embeddedFont?: string
  /** horizontal gap to the previous fragment on the same line; 0 for a line's first fragment */
  gap: number
}

function inferFontFamily(probe: string, style?: TextStyle): TextFontFamily {
  if (style?.isMono || /mono|courier|consolas|menlo|fira\s*code|jetbrains/i.test(probe)) {
    return 'mono'
  }
  const cleaned = probe.replace(/sans-?serif/gi, '')
  if (style?.isSerif || /serif|times|georgia|garamond|cambria|palatino/i.test(cleaned)) {
    return 'serif'
  }
  return 'sans'
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
    const style = styles?.[fontName]
    // pdf.js often normalizes embedded fonts to a generic family, so these flags combine styles + commonObjs
    const probe = `${style?.fontFamily ?? ''} ${fontName}`
    fragments.push({
      str: item.str,
      x1,
      x2: x1 + width,
      baseline,
      fontSize,
      height: finite(item.height) && item.height > 0 ? item.height : fontSize,
      bold: Boolean(style?.bold) || /bold|black|semibold|demi|heavy/i.test(probe),
      italic: Boolean(style?.italic) || /italic|oblique/i.test(probe),
      fontFamily: inferFontFamily(probe, style),
      ...(style?.fontName ? { fontName: style.fontName } : {}),
      ...(style?.embeddedFont ? { embeddedFont: style.embeddedFont } : {}),
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
    const first = line.fragments[0]
    const fontFamily = first?.fontFamily ?? 'sans'
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
      ...(fontFamily !== 'sans' ? { fontFamily } : {}),
      ...(first?.fontName ? { fontName: first.fontName } : {}),
      ...(first?.embeddedFont ? { embeddedFont: first.embeddedFont } : {}),
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

  const iw = x2 - x1
  const ih = y2 - y1
  const border: [number, number][] = []
  // Sample along all 4 edges just outside the box so adjacent-line ink on one edge cannot taint bg
  for (const frac of [0.15, 0.38, 0.62, 0.85]) {
    const bx = clamp(Math.floor(x1 + iw * frac), 0, w - 1)
    const by = clamp(Math.floor(y1 + ih * frac), 0, h - 1)
    border.push(
      [clamp(x1 - 1, 0, w - 1), by],
      [clamp(x2, 0, w - 1), by],
      [bx, clamp(y1 - 1, 0, h - 1)],
      [bx, clamp(y2, 0, h - 1)],
    )
  }

  // Coarse interior grid: enough probes to find the ink color, few enough to stay cheap
  const probes: [number, number][] = []
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

  const borderSamples = border.map(([x, y]) => pixel(x, y))
  const luma = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
  borderSamples.sort((a, b) => luma(a) - luma(b))
  const bg = borderSamples[Math.floor(borderSamples.length / 2)]!

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
    fontFamily?: TextFontFamily
    fontName?: string
    embeddedFont?: string
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
  const fontFamily = opts.fontFamily ?? block.fontFamily ?? 'sans'
  const fontName = opts.fontName ?? block.fontName
  const embeddedFont =
    bold === block.bold && italic === block.italic
      ? (opts.embeddedFont ?? block.embeddedFont)
      : undefined
  const colors = canvas
    ? sampleCanvasColors(canvas, pdfRectToCss(geom, block.origRect, opts.scale ?? 1))
    : { bgColor: FALLBACK_BG, color: FALLBACK_FG }
  const rendered = renderTextBox(text, fontSize, colors.color, {
    bold,
    italic,
    underline,
    fontFamily,
    fontName,
    embeddedFont,
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
    ...(fontFamily !== 'sans' ? { fontFamily } : {}),
    ...(fontName ? { fontName } : {}),
    ...(embeddedFont ? { embeddedFont } : {}),
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
