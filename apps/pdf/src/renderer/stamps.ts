import type { StampInput } from '../shared/ipc'

/** Bitmap supersampling factor relative to PDF pt — stays sharp even when enlarged for print */
const SS = 4

export interface WatermarkConfig {
  text: string
  /** 'center' = single center watermark, 'tile' = repeated multi-text grid across the whole page */
  layout?: 'center' | 'tile'
  /** Counterclockwise angle */
  angle: number
  opacity: number
  color: string
  /** Font size as a ratio of page width */
  sizeRatio: number
}

export interface HeaderFooterConfig {
  headerLeft: string
  headerCenter: string
  headerRight: string
  footerLeft: string
  footerCenter: string
  footerRight: string
  /** Auto page number in the footer center (overrides footerCenter) */
  pageNumber: boolean
  startAt: number
  fontSize: number
  color: string
}

export const DEFAULT_WATERMARK: WatermarkConfig = {
  text: '',
  layout: 'center',
  angle: 35,
  opacity: 0.18,
  color: '#d0342c',
  sizeRatio: 0.11,
}

export const DEFAULT_HEADER_FOOTER: HeaderFooterConfig = {
  headerLeft: '',
  headerCenter: '',
  headerRight: '',
  footerLeft: '',
  footerCenter: '',
  footerRight: '',
  pageNumber: true,
  startAt: 1,
  fontSize: 9,
  color: '#666666',
}

const FONT = (px: number, bold = false, italic = false) =>
  `${italic ? 'italic ' : ''}${bold ? '600 ' : ''}${px}px -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`

function toBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png').split(',')[1] ?? ''
}

/**
 * Watermark bitmap: full-page transparent canvas with text rendered at center or tiled across page.
 * Uses a bitmap because pdf-lib's built-in fonts lack CJK, and embedding fonts would
 * bundle several MB of font data.
 */
export function renderWatermark(cfg: WatermarkConfig, pw: number, ph: number): string | null {
  const rawText = cfg.text.trim()
  if (!rawText) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(pw * SS)
  canvas.height = Math.round(ph * SS)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const isTile = cfg.layout === 'tile'
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return null

  ctx.fillStyle = cfg.color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  if (!isTile) {
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((-cfg.angle * Math.PI) / 180)
    // Shrink long text to the diagonal so slanted ends aren't clipped by the page
    let size = pw * cfg.sizeRatio * SS
    ctx.font = FONT(size, true)
    const maxW = Math.hypot(canvas.width, canvas.height) * 0.8
    let maxLineW = 0
    for (const line of lines) {
      maxLineW = Math.max(maxLineW, ctx.measureText(line).width)
    }
    if (maxLineW > maxW) {
      size *= maxW / maxLineW
      ctx.font = FONT(size, true)
    }
    const lineHeight = size * 1.25
    const startY = -((lines.length - 1) * lineHeight) / 2
    lines.forEach((line, i) => {
      ctx.fillText(line, 0, startY + i * lineHeight)
    })
  } else {
    // Tile (multi-text): repeat watermark in a balanced grid across the page
    const tileScale = 0.42
    const size = pw * cfg.sizeRatio * tileScale * SS
    ctx.font = FONT(size, true)

    let maxLineW = 0
    for (const line of lines) {
      maxLineW = Math.max(maxLineW, ctx.measureText(line).width)
    }

    const lineHeight = size * 1.25
    const textBlockH = lines.length * lineHeight
    const rad = (-cfg.angle * Math.PI) / 180
    const cos = Math.abs(Math.cos(rad))
    const sin = Math.abs(Math.sin(rad))
    const rotW = maxLineW * cos + textBlockH * sin
    const rotH = maxLineW * sin + textBlockH * cos

    const stepX = Math.max(rotW * 1.35, canvas.width / 3)
    const stepY = Math.max(rotH * 1.5, canvas.height / 5)

    const cols = Math.ceil(canvas.width / stepX) + 1
    const rows = Math.ceil(canvas.height / stepY) + 1

    for (let r = 0; r <= rows; r++) {
      const y = (r - 0.5) * stepY
      const xOffset = r % 2 === 1 ? stepX * 0.5 : 0
      for (let c = -1; c <= cols; c++) {
        const x = c * stepX + xOffset
        ctx.save?.()
        ctx.translate(x, y)
        ctx.rotate(rad)
        const startY = -((lines.length - 1) * lineHeight) / 2
        lines.forEach((line, i) => {
          ctx.fillText(line, 0, startY + i * lineHeight)
        })
        ctx.restore?.()
      }
    }
  }

  return toBase64(canvas)
}

/** Header or footer bar: transparent canvas of full page width × bar height, in left/center/right segments */
function renderBar(
  parts: [string, string, string],
  pw: number,
  fontSize: number,
  color: string,
): string | null {
  if (parts.every((p) => !p.trim())) return null
  const h = Math.round(fontSize * 2.2)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(pw * SS)
  canvas.height = h * SS
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(SS, SS)
  ctx.font = FONT(fontSize)
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  const pad = pw * 0.06
  const y = h / 2
  const [left, center, right] = parts
  if (left.trim()) {
    ctx.textAlign = 'left'
    ctx.fillText(left, pad, y)
  }
  if (center.trim()) {
    ctx.textAlign = 'center'
    ctx.fillText(center, pw / 2, y)
  }
  if (right.trim()) {
    ctx.textAlign = 'right'
    ctx.fillText(right, pw - pad, y)
  }
  return toBase64(canvas)
}

/**
 * A typewriter (FreeText) text box as a bitmap, with its size in PDF pt so the caller can size
 * the annotation rect. Multi-line on \n. Bitmap for the same reason as the watermark: pdf-lib's
 * built-in fonts are WinAnsi-only, so rasterizing is what makes CJK typewriter text work.
 * `bold`/`italic` only affect the rasterized font; `bgColor` fills the box behind the text.
 */
export function renderTextBox(
  text: string,
  fontSize: number,
  color: string,
  opts: { bold?: boolean; italic?: boolean; underline?: boolean; bgColor?: string } = {},
): { image: string; width: number; height: number } | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.every((l) => !l.trim())) return null
  const { bold = false, italic = false, underline = false, bgColor } = opts

  const pad = Math.max(2, fontSize * 0.25)
  const lineH = fontSize * 1.3
  // Measure at 1x so the result is already in pt, matching the annotation's user-space rect
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe) return null
  probe.font = FONT(fontSize, bold, italic)
  const width = Math.max(...lines.map((l) => probe.measureText(l).width))

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil((width + pad * 2) * SS))
  canvas.height = Math.max(1, Math.ceil((lineH * lines.length + pad * 2) * SS))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(SS, SS)
  ctx.font = FONT(fontSize, bold, italic)
  // Background first, so the supersampled text sits on top of it
  if (bgColor) {
    ctx.fillStyle = bgColor
    ctx.fillRect(0, 0, canvas.width / SS, canvas.height / SS)
  }
  ctx.fillStyle = color
  ctx.textBaseline = 'top'
  lines.forEach((line, i) => {
    const x = pad
    const y = pad + lineH * i
    ctx.fillText(line, x, y)
    if (underline && line.trim()) {
      const lineWidth = ctx.measureText(line).width
      const uY = Math.round(y + fontSize * 1.05)
      const uH = Math.max(1, Math.round(fontSize * 0.08))
      ctx.fillRect(x, uY, lineWidth, uH)
    }
  })
  return { image: toBase64(canvas), width: canvas.width / SS, height: canvas.height / SS }
}

/** Replace {page}/{total} placeholders */
const fill = (tpl: string, page: number, total: number) =>
  tpl.replaceAll('{page}', String(page)).replaceAll('{total}', String(total))

/**
 * Build stamps for each target page. pages provides (original page index, unrotated
 * page size, display number). Headers/footers are placed in unrotated coordinates and
 * follow rotation consistently with the page's /Rotate.
 */
export function buildStamps(
  pages: { origIdx: number; pw: number; ph: number; displayNo: number }[],
  watermark: WatermarkConfig | null,
  hf: HeaderFooterConfig | null,
): StampInput[] {
  const out: StampInput[] = []
  const total = pages.length
  // Pages of the same size share one watermark bitmap, avoiding re-rendering in large docs
  const wmCache = new Map<string, string | null>()

  for (const p of pages) {
    if (watermark?.text.trim()) {
      const key = `${Math.round(p.pw)}x${Math.round(p.ph)}`
      if (!wmCache.has(key)) wmCache.set(key, renderWatermark(watermark, p.pw, p.ph))
      const image = wmCache.get(key)
      if (image) {
        out.push({
          pageIndex: p.origIdx,
          image,
          rect: [0, 0, p.pw, p.ph],
          opacity: watermark.opacity,
        })
      }
    }

    if (!hf) continue
    const no = hf.startAt + p.displayNo - 1
    const barH = hf.fontSize * 2.2
    const margin = Math.min(p.ph * 0.035, 26)

    const header = renderBar(
      [hf.headerLeft, hf.headerCenter, hf.headerRight].map((s) => fill(s, no, total)) as [
        string,
        string,
        string,
      ],
      p.pw,
      hf.fontSize,
      hf.color,
    )
    if (header) {
      out.push({
        pageIndex: p.origIdx,
        image: header,
        rect: [0, p.ph - margin - barH, p.pw, p.ph - margin],
      })
    }

    const footerCenter = hf.pageNumber ? `${no} / ${total}` : fill(hf.footerCenter, no, total)
    const footer = renderBar(
      [fill(hf.footerLeft, no, total), footerCenter, fill(hf.footerRight, no, total)],
      p.pw,
      hf.fontSize,
      hf.color,
    )
    if (footer) {
      out.push({ pageIndex: p.origIdx, image: footer, rect: [0, margin, p.pw, margin + barH] })
    }
  }
  return out
}
