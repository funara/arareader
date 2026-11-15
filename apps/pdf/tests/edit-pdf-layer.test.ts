import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditPdfLayer } from '../src/renderer/EditPdfLayer'
import type { PageContentEdit } from '../src/renderer/content-edit'
import { textBoxPadding } from '../src/renderer/stamps'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let container: HTMLDivElement
let root: Root

function stubCanvas(charWidth = 10) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const ctx = {
      font: '',
      fillStyle: '',
      textAlign: '',
      textBaseline: '',
      scale: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: (text: string) => ({ width: text.length * charWidth }),
      getImageData: () => ({
        data: new Uint8ClampedArray(16).fill(255),
      }),
    }
    return ctx as unknown as CanvasRenderingContext2D
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG_DATA_URL)
}

function makeFakeDoc(opts: {
  str: string
  width: number
  fontSize: number
  bold?: boolean
  italic?: boolean
  fallbackName?: string
  pdfFontName?: string
  loadedName?: string
}) {
  const fontId = 'g_d0_f1'
  const page = {
    getTextContent: async () => ({
      items: [
        {
          str: opts.str,
          width: opts.width,
          height: opts.fontSize,
          fontName: fontId,
          transform: [opts.fontSize, 0, 0, opts.fontSize, 72, 700],
        },
      ],
      styles: {
        [fontId]: { fontFamily: opts.fallbackName ?? 'sans-serif' },
      },
    }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    commonObjs: {
      has: (id: string) => id === fontId,
      get: (id: string) =>
        id === fontId
          ? {
              name: opts.pdfFontName,
              bold: Boolean(opts.bold),
              italic: Boolean(opts.italic),
              loadedName: opts.loadedName ?? 'g_d0_f1',
              fallbackName: opts.fallbackName ?? 'sans-serif',
            }
          : null,
    },
  }
  return {
    getPage: async () => page,
  } as unknown as PDFDocumentProxy
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** React tracks `select.value`; the prototype setter updates the value without updating that tracker */
function selectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function clickBlock(blockEl: Element) {
  act(() => {
    blockEl.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 80, clientY: 80, bubbles: true }),
    )
  })
  act(() => {
    blockEl.dispatchEvent(
      new PointerEvent('pointerup', { button: 0, clientX: 80, clientY: 80, bubbles: true }),
    )
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  // jsdom lacks setPointerCapture on HTMLElement
  HTMLElement.prototype.setPointerCapture = vi.fn()
})

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
})

describe('EditPdfLayer inline text editor UX', () => {
  it('preserves bold weight, uses Latin-first font stack, and expands width so trailing words are not clipped', async () => {
    // Editor font measures wider (16px/char -> 352px) than the PDF item width (280px)
    stubCanvas(16)
    const doc = makeFakeDoc({
      str: 'The Midterm Case Study',
      width: 280,
      fontSize: 33,
      bold: true,
    })

    await act(async () => {
      root.render(
        createElement(EditPdfLayer, {
          doc,
          pageNo: 1,
          geom: { pw: 612, ph: 792, rot: 0 },
          scale: 1,
          editMode: true,
          edits: [],
          readOnly: false,
          onCommit: vi.fn(),
          onDraftActivity: vi.fn(),
        }),
      )
    })
    await flush()

    const block = container.querySelector('.pdf-content-block')
    expect(block).not.toBeNull()
    clickBlock(block!)

    const textarea = container.querySelector<HTMLTextAreaElement>('.pdf-content-editor-text')
    expect(textarea).not.toBeNull()
    expect(textarea!.value).toBe('The Midterm Case Study')
    expect(textarea!.style.fontWeight).toBe('700')
    expect(textarea!.style.fontSize).toBe('33px')
    // Latin fonts precede CJK fallbacks so Windows does not render Latin text in Microsoft YaHei
    const fontFamily = textarea!.style.fontFamily
    expect(fontFamily.indexOf('Arial')).toBeGreaterThanOrEqual(0)
    expect(fontFamily.indexOf('Arial')).toBeLessThan(fontFamily.indexOf('Microsoft YaHei'))

    // Toolbar Bold toggle reflects the detected bold state
    const boldBtn = container.querySelector<HTMLButtonElement>(
      '.pdf-content-toolbar button[title*="Bold"]',
    )
    expect(boldBtn?.classList.contains('pdf-content-toggle-on')).toBe(true)

    // Box width expands beyond the original 283px block width to fit the measured 352px text
    const boxWidth = parseFloat(textarea!.style.width)
    expect(boxWidth).toBeGreaterThan(352)
  })

  it('keeps serif font family when editing serif PDF text', async () => {
    stubCanvas(10)
    const doc = makeFakeDoc({
      str: 'Serif Heading',
      width: 120,
      fontSize: 20,
      italic: true,
      fallbackName: 'serif',
    })

    await act(async () => {
      root.render(
        createElement(EditPdfLayer, {
          doc,
          pageNo: 1,
          geom: { pw: 612, ph: 792, rot: 0 },
          scale: 1,
          editMode: true,
          edits: [],
          readOnly: false,
          onCommit: vi.fn(),
          onDraftActivity: vi.fn(),
        }),
      )
    })
    await flush()

    clickBlock(container.querySelector('.pdf-content-block')!)
    const textarea = container.querySelector<HTMLTextAreaElement>('.pdf-content-editor-text')
    expect(textarea!.style.fontStyle).toBe('italic')
    expect(textarea!.style.fontFamily).toContain('Times New Roman')
  })

  it('commits text anchored at textOrigin minus renderTextBox padding so text does not jump on Apply', async () => {
    stubCanvas(10)
    const doc = makeFakeDoc({
      str: 'Title',
      width: 80,
      fontSize: 32,
      bold: true,
    })
    const committed: PageContentEdit[] = []

    await act(async () => {
      root.render(
        createElement(EditPdfLayer, {
          doc,
          pageNo: 1,
          geom: { pw: 612, ph: 792, rot: 0 },
          scale: 1,
          editMode: true,
          edits: [],
          readOnly: false,
          onCommit: (edit) => committed.push(edit),
          onDraftActivity: vi.fn(),
        }),
      )
    })
    await flush()

    clickBlock(container.querySelector('.pdf-content-block')!)

    const applyBtn = Array.from(container.querySelectorAll('.pdf-content-toolbar button')).at(-1)!
    act(() => {
      applyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(committed).toHaveLength(1)
    const edit = committed[0]!
    expect(edit.kind).toBe('text')
    if (edit.kind === 'text') {
      const pad = textBoxPadding(32)
      // origRect left is 72 - 1.5 = 70.5, textOrigin.left is 72, so bitmap rect[0] is 72 - pad
      expect(edit.rect[0]).toBeCloseTo(72 - pad, 5)
      expect(edit.bold).toBe(true)
    }
  })

  it('uses the detected PDF font family consistently in both editor and saved bitmap', async () => {
    const fontsUsed: string[] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const ctx = {
        _font: '',
        get font() {
          return this._font
        },
        set font(v: string) {
          this._font = v
          fontsUsed.push(v)
        },
        fillStyle: '',
        textAlign: '',
        textBaseline: '',
        scale: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        measureText: (text: string) => ({ width: text.length * 10 }),
        getImageData: () => ({
          data: new Uint8ClampedArray(16).fill(255),
        }),
      }
      return ctx as unknown as CanvasRenderingContext2D
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG_DATA_URL)

    const doc = makeFakeDoc({
      str: 'The Midterm Case Study',
      width: 240,
      fontSize: 33,
      pdfFontName: 'ABCDEF+Inter-Bold',
    })
    const committed: PageContentEdit[] = []

    await act(async () => {
      root.render(
        createElement(EditPdfLayer, {
          doc,
          pageNo: 1,
          geom: { pw: 612, ph: 792, rot: 0 },
          scale: 1,
          editMode: true,
          edits: [],
          readOnly: false,
          onCommit: (edit) => committed.push(edit),
          onDraftActivity: vi.fn(),
        }),
      )
    })
    await flush()

    clickBlock(container.querySelector('.pdf-content-block')!)

    const textarea = container.querySelector<HTMLTextAreaElement>('.pdf-content-editor-text')!
    expect(textarea.style.fontWeight).toBe('700')
    expect(textarea.style.fontFamily).toContain('Inter')

    const applyBtn = Array.from(container.querySelectorAll('.pdf-content-toolbar button')).at(-1)!
    act(() => {
      applyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(committed).toHaveLength(1)
    const edit = committed[0]!
    expect(edit.kind).toBe('text')
    if (edit.kind === 'text') {
      expect(edit.fontName).toBe('Inter')
      expect(fontsUsed.at(-1)).toContain('"Inter"')
      expect(fontsUsed.at(-1)).toContain('700 33px')
    }
  })

  it('lets the user replace the detected font and restores it with Original', async () => {
    stubCanvas(10)
    const doc = makeFakeDoc({
      str: 'Finding Edges.',
      width: 180,
      fontSize: 32,
      pdfFontName: 'ABCDEF+Inter-Bold',
    })
    const committed: PageContentEdit[] = []
    const renderLayer = (edits: PageContentEdit[]) =>
      act(async () => {
        root.render(
          createElement(EditPdfLayer, {
            doc,
            pageNo: 1,
            geom: { pw: 612, ph: 792, rot: 0 },
            scale: 1,
            editMode: true,
            edits,
            readOnly: false,
            onCommit: (edit) => committed.push(edit),
            onDraftActivity: vi.fn(),
          }),
        )
      })

    await renderLayer([])
    await flush()

    clickBlock(container.querySelector('.pdf-content-block')!)
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Font family"]')
    expect(select).not.toBeNull()
    expect(select!.value).toBe('original')
    expect(select!.options[0]!.textContent).toContain('Inter')

    selectValue(select!, 'serif')
    const editor = () => container.querySelector<HTMLTextAreaElement>('.pdf-content-editor-text')!
    expect(editor().style.fontFamily).toContain('Times New Roman')
    expect(editor().style.fontFamily).not.toContain('Inter')

    const applyBtn = Array.from(container.querySelectorAll('.pdf-content-toolbar button')).at(-1)!
    act(() => {
      applyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(committed).toHaveLength(1)
    const edit = committed[0]!
    expect(edit.kind).toBe('text')
    if (edit.kind === 'text') {
      expect(edit.fontChoice).toBe('serif')
      expect(edit.fontFamily).toBe('serif')
      // The previous face is cleared, not carried over through the base edit
      expect(edit.fontName).toBeUndefined()
      expect(edit.embeddedFont).toBeUndefined()
    }

    // Reopening the committed edit keeps the selected family
    await renderLayer(committed)
    await flush()
    clickBlock(container.querySelector('.pdf-content-block')!)
    const reopened = container.querySelector<HTMLSelectElement>('select[aria-label="Font family"]')!
    expect(reopened.value).toBe('serif')
    expect(editor().style.fontFamily).not.toContain('Inter')

    selectValue(reopened, 'original')
    expect(reopened.value).toBe('original')
    expect(editor().style.fontFamily).toContain('Inter')
  })

  it('renders transparent replacement text and preserves baseline when fontBoundingBoxAscent differs from item height', async () => {
    const fillRectCalls: number[][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const ctx = {
        font: '',
        fillStyle: '',
        textAlign: '',
        textBaseline: '',
        scale: vi.fn(),
        fillRect: (...args: number[]) => fillRectCalls.push(args),
        fillText: vi.fn(),
        measureText: (text: string) => ({
          width: text.length * 20,
          fontBoundingBoxAscent: 54,
        }),
        getImageData: () => ({
          data: new Uint8ClampedArray(16).fill(255),
        }),
      }
      return ctx as unknown as CanvasRenderingContext2D
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG_DATA_URL)

    const doc = makeFakeDoc({
      str: 'Edges.',
      width: 140,
      fontSize: 60,
      bold: true,
    })
    const committed: PageContentEdit[] = []

    await act(async () => {
      root.render(
        createElement(EditPdfLayer, {
          doc,
          pageNo: 1,
          geom: { pw: 612, ph: 792, rot: 0 },
          scale: 1,
          editMode: true,
          edits: [],
          readOnly: false,
          onCommit: (edit) => committed.push(edit),
          onDraftActivity: vi.fn(),
        }),
      )
    })
    await flush()

    clickBlock(container.querySelector('.pdf-content-block')!)

    const textarea = container.querySelector<HTMLTextAreaElement>('.pdf-content-editor-text')!
    expect(textarea.style.background).toBe('transparent')

    fillRectCalls.length = 0
    const applyBtn = Array.from(container.querySelectorAll('.pdf-content-toolbar button')).at(-1)!
    act(() => {
      applyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(committed).toHaveLength(1)
    const edit = committed[0]!
    expect(edit.kind).toBe('text')
    if (edit.kind === 'text') {
      // No solid bgColor rectangle is painted inside the padded replacement PNG (no overlap onto neighboring lines)
      expect(fillRectCalls).toHaveLength(0)
      // Baseline sits at PDF y = 700 (`baselineY = 792 - 700 = 92`), so rect top is `92 - ascent(54) - pad(15)`
      // in display Y -> PDF rect[3] = 792 - (92 - 54 - 15) = 700 + 54 + 15 = 769
      const pad = textBoxPadding(60)
      expect(edit.rect[3]).toBeCloseTo(700 + 54 + pad, 4)
    }
  })
})
