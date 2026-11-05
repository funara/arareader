import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HEADER_FOOTER,
  DEFAULT_WATERMARK,
  buildStamps,
  renderTextBox,
  renderWatermark,
  type HeaderFooterConfig,
  type WatermarkConfig,
} from '../src/renderer/stamps'

interface FakeCtx {
  texts: string[]
  /** Ordered draw log, so tests can assert a background fill happens before the text */
  ops: string[]
  font: string
  fillStyle: string
  textAlign: string
  textBaseline: string
  translate: () => void
  rotate: () => void
  scale: () => void
  save: () => void
  restore: () => void
  measureText: (text: string) => { width: number }
  fillRect: (x: number, y: number, w: number, h: number) => void
  fillText: (text: string, x: number, y: number) => void
}

let contexts: FakeCtx[]

function makeCtx(): FakeCtx {
  const ctx: FakeCtx = {
    texts: [],
    ops: [],
    font: '',
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    measureText: (text) => ({ width: text.length * 10 }),
    fillRect: () => {
      ctx.ops.push(`fill:${ctx.fillStyle}`)
    },
    fillText: (text) => {
      ctx.texts.push(text)
      ctx.ops.push(`text:${text}`)
    },
  }
  return ctx
}

beforeEach(() => {
  contexts = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const ctx = makeCtx()
    contexts.push(ctx)
    return ctx as unknown as CanvasRenderingContext2D
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,FAKEBASE64',
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

const wm = (over: Partial<WatermarkConfig> = {}): WatermarkConfig => ({
  ...DEFAULT_WATERMARK,
  text: 'CONFIDENTIAL',
  ...over,
})

const page = (origIdx: number, displayNo: number, pw = 600, ph = 800) => ({
  origIdx,
  pw,
  ph,
  displayNo,
})

describe('renderWatermark', () => {
  it('returns null for empty or whitespace-only text', () => {
    expect(renderWatermark(wm({ text: '' }), 600, 800)).toBeNull()
    expect(renderWatermark(wm({ text: '   ' }), 600, 800)).toBeNull()
  })

  it('renders trimmed text and returns the base64 payload without the data prefix', () => {
    const result = renderWatermark(wm({ text: '  Draft  ' }), 600, 800)
    expect(result).toBe('FAKEBASE64')
    expect(contexts[0]!.texts).toEqual(['Draft'])
    expect(contexts[0]!.fillStyle).toBe(DEFAULT_WATERMARK.color)
  })

  it('renders multi-line watermark text', () => {
    const result = renderWatermark(wm({ text: 'CONFIDENTIAL\nDO NOT COPY' }), 600, 800)
    expect(result).toBe('FAKEBASE64')
    expect(contexts[0]!.texts).toEqual(['CONFIDENTIAL', 'DO NOT COPY'])
  })

  it('renders tiled multi-text watermark across grid', () => {
    const result = renderWatermark(wm({ text: 'SAMPLE', layout: 'tile' }), 600, 800)
    expect(result).toBe('FAKEBASE64')
    expect(contexts[0]!.texts.length).toBeGreaterThan(1)
    expect(contexts[0]!.texts.every((t) => t === 'SAMPLE')).toBe(true)
  })

  it('returns null when the 2d context is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(renderWatermark(wm(), 600, 800)).toBeNull()
  })
})

describe('buildStamps watermark', () => {
  it('emits one full-page stamp per page with the configured opacity', () => {
    const stamps = buildStamps([page(0, 1), page(3, 2)], wm({ opacity: 0.3 }), null)
    expect(stamps).toHaveLength(2)
    expect(stamps[0]).toEqual({
      pageIndex: 0,
      image: 'FAKEBASE64',
      rect: [0, 0, 600, 800],
      opacity: 0.3,
    })
    expect(stamps[1]!.pageIndex).toBe(3)
  })

  it('reuses one rendered bitmap for same-size pages but not across sizes', () => {
    buildStamps([page(0, 1), page(1, 2)], wm(), null)
    expect(contexts).toHaveLength(1)

    contexts = []
    buildStamps([page(0, 1, 600, 800), page(1, 2, 595, 842)], wm(), null)
    expect(contexts).toHaveLength(2)
  })

  it('emits nothing for a blank watermark and no header/footer', () => {
    expect(buildStamps([page(0, 1)], wm({ text: '  ' }), null)).toEqual([])
    expect(buildStamps([page(0, 1)], null, null)).toEqual([])
  })
})

describe('buildStamps header/footer', () => {
  const hf = (over: Partial<HeaderFooterConfig> = {}): HeaderFooterConfig => ({
    ...DEFAULT_HEADER_FOOTER,
    ...over,
  })

  it('renders an auto page-number footer positioned at the bottom margin', () => {
    const stamps = buildStamps([page(5, 1), page(6, 2)], null, hf())
    expect(stamps).toHaveLength(2)
    const barH = DEFAULT_HEADER_FOOTER.fontSize * 2.2
    const margin = Math.min(800 * 0.035, 26)
    expect(stamps[0]).toEqual({
      pageIndex: 5,
      image: 'FAKEBASE64',
      rect: [0, margin, 600, margin + barH],
    })
    expect(contexts[0]!.texts).toEqual(['1 / 2'])
    expect(contexts[1]!.texts).toEqual(['2 / 2'])
  })

  it('honors startAt for page numbering', () => {
    buildStamps([page(0, 1)], null, hf({ startAt: 10 }))
    expect(contexts[0]!.texts).toEqual(['10 / 1'])
  })

  it('places headers at the top and fills {page}/{total} placeholders', () => {
    const stamps = buildStamps(
      [page(0, 1)],
      null,
      hf({ headerLeft: 'p{page} of {total}', headerRight: 'ACME', pageNumber: false }),
    )
    expect(stamps).toHaveLength(1)
    expect(contexts[0]!.texts).toEqual(['p1 of 1', 'ACME'])
    const barH = DEFAULT_HEADER_FOOTER.fontSize * 2.2
    const margin = Math.min(800 * 0.035, 26)
    expect(stamps[0]!.rect).toEqual([0, 800 - margin - barH, 600, 800 - margin])
  })

  it('uses footerCenter text when pageNumber is disabled', () => {
    buildStamps([page(0, 1)], null, hf({ pageNumber: false, footerCenter: 'Page {page}' }))
    expect(contexts[0]!.texts).toEqual(['Page 1'])
  })

  it('emits no bars when all segments are blank and pageNumber is off', () => {
    expect(buildStamps([page(0, 1)], null, hf({ pageNumber: false }))).toEqual([])
  })

  it('combines watermark, header, and footer stamps for one page', () => {
    const stamps = buildStamps([page(0, 1)], wm(), hf({ headerCenter: 'Title' }))
    expect(stamps).toHaveLength(3)
    expect(stamps.map((s) => s.pageIndex)).toEqual([0, 0, 0])
  })
})

describe('renderTextBox', () => {
  // contexts[0] is the 1x measuring probe, contexts[1] the supersampled draw canvas
  const probe = () => contexts[0]!
  const draw = () => contexts[1]!

  it('draws plain text by default and returns pt-sized dimensions', () => {
    const box = renderTextBox('Hi', 12, '#14171f')
    expect(box).not.toBeNull()
    expect(probe().font).toBe(draw().font)
    expect(draw().font).not.toContain('600')
    expect(draw().font).not.toContain('italic')
    expect(draw().texts).toEqual(['Hi'])
    expect(draw().ops).toEqual(['text:Hi'])
    expect(draw().fillStyle).toBe('#14171f')
    // 2 chars × 10pt + 2 × 3pt padding, supersampling divided back out
    expect(box!.width).toBeCloseTo(26, 5)
    expect(box!.height).toBeCloseTo(21.75, 5)
  })

  it('uses the bold weight for measuring and drawing', () => {
    const box = renderTextBox('Hi', 12, '#14171f', { bold: true })
    expect(box).not.toBeNull()
    expect(probe().font).toContain('600 ')
    expect(draw().font).toBe(probe().font)
    expect(draw().font).not.toContain('italic')
    expect(draw().texts).toEqual(['Hi'])
  })

  it('uses the italic style for measuring and drawing', () => {
    const box = renderTextBox('Hi', 12, '#14171f', { italic: true })
    expect(box).not.toBeNull()
    expect(probe().font).toContain('italic ')
    expect(draw().font).toBe(probe().font)
    expect(draw().font).not.toContain('600')
  })

  it('puts italic before the bold weight in the font string', () => {
    renderTextBox('Hi', 12, '#14171f', { bold: true, italic: true })
    expect(draw().font.startsWith('italic 600 ')).toBe(true)
  })

  it('draws an underline beneath the text when underline is true', () => {
    const box = renderTextBox('Hi', 12, '#14171f', { underline: true })
    expect(box).not.toBeNull()
    expect(draw().ops).toEqual(['text:Hi', 'fill:#14171f'])
  })

  it('fills the whole canvas with bgColor before drawing the text', () => {
    const box = renderTextBox('Hi', 12, '#14171f', { bgColor: '#eef2ff' })
    expect(box).not.toBeNull()
    expect(draw().ops).toEqual(['fill:#eef2ff', 'text:Hi'])
    // The text color is restored after the background fill
    expect(draw().fillStyle).toBe('#14171f')
  })

  it('does not fill the canvas when bgColor is omitted or blank', () => {
    renderTextBox('Hi', 12, '#14171f')
    expect(draw().ops).toEqual(['text:Hi'])
    contexts = []
    renderTextBox('Hi', 12, '#14171f', { bgColor: '' })
    expect(draw().ops).toEqual(['text:Hi'])
  })

  it('returns null for blank text', () => {
    expect(renderTextBox('   ', 12, '#14171f')).toBeNull()
    expect(contexts).toHaveLength(0)
  })
})
