import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { geomDispSize, pdfRectToCss } from './annotations'
import type { PageGeom } from './annotations'
import {
  buildTextEdit,
  cropCanvasImage,
  displayBoxToPdf,
  extractPageImages,
  extractPageTextBlocks,
  imageFileToPng,
  renderSolidPatch,
  sampleCanvasColors,
} from './content-edit'
import type {
  CanvasBox,
  EditablePageImage,
  EditableTextBlock,
  ImageContentEdit,
  PageContentEdit,
  Rect,
  TextContentEdit,
} from './content-edit'
import { t } from './i18n/locale'
import { renderTextBox } from './stamps'

/** Same stack as the rasterized text boxes, so the inline editor matches the committed bitmap */
const EDITOR_FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif'
/** Matches the content-edit fallbacks used when the page canvas cannot be sampled */
const FALLBACK_BG = '#ffffff'
const FALLBACK_FG = '#14171f'
/** Below this many displayed px a press is a click, not a drag */
const MIN_DRAG_PX = 3
const MIN_FONT = 4
const MAX_FONT = 96
/** Smallest box a corner handle may drag to, in display px */
const MIN_BOX_PX = 8
/** Approximate toolbar height, so it floats just above its box */
const BAR_OFFSET = 34

const clampFont = (v: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(v)))

/**
 * Viewport-aware floating toolbar placement.
 * - Vertical: Normally sits above the box. Flips below if too close to the top of the page.
 * - Horizontal: If in the right half of the page, anchors to the right edge of the box and flows left
 *   (preventing right boundary overflow); if in the left half, anchors to the left edge and flows right.
 */
function getFloatingStyle(geom: PageGeom, scale: number, box: CanvasBox): CSSProperties {
  const disp = geomDispSize(geom)
  const pageW = disp.width * scale
  const boxL = box.left * scale
  const boxR = (box.left + box.width) * scale
  const boxT = box.top * scale
  const boxB = (box.top + box.height) * scale

  const margin = 8
  const isTopEdge = boxT < BAR_OFFSET + 4
  const isRightSide = (boxL + boxR) / 2 > pageW / 2

  const style: CSSProperties = {
    position: 'absolute',
    pointerEvents: 'auto',
  }

  if (isTopEdge) {
    style.top = boxB + 6
  } else {
    style.top = Math.max(margin, boxT - BAR_OFFSET)
  }

  if (isRightSide) {
    style.right = Math.max(margin, pageW - boxR)
    style.left = 'auto'
  } else {
    style.left = Math.max(margin, boxL)
    style.right = 'auto'
  }

  return style
}

interface TextDrag {
  block: EditableTextBlock
  /** displayed rect when the drag started */
  rect: Rect
  /** client coords when the drag started */
  origin: [number, number]
  /** offset from the start, display px (scale=1) */
  dx: number
  dy: number
  moved: boolean
  /** First drag of an unedited block: its raster follows the pointer until commit */
  preview: TextContentEdit | null
}

interface ImageDrag {
  image: EditablePageImage
  rect: Rect
  origin: [number, number]
  dx: number
  dy: number
  moved: boolean
  /** First drag of an unedited image: its crop follows the pointer until commit */
  preview: ImageContentEdit | null
}

interface ImageResize {
  image: EditablePageImage
  /** 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right */
  corner: number
  /** box at drag start, display px */
  start: CanvasBox
  /** live box, display px */
  box: CanvasBox
  /** First resize of an unedited image: its crop scales with the handles */
  preview: ImageContentEdit | null
}

/** Inline text editor: the base edit plus the draft typed into the textarea */
interface Draft {
  /** committed edit when one exists, else the synthetic base for the first commit */
  base: TextContentEdit
  /** editor box, display px (scale=1) */
  box: CanvasBox
  text: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  color: string
  bgColor: string
}

/**
 * Direct text & image editing overlay for one page.
 *
 * Everything here is additive: a text/image edit only ever hides the original with a
 * background-matched whiteout patch and draws a replacement bitmap (or, for text, a raster
 * that the save path also writes as FreeText). The page's own content stream is never touched,
 * so subsetted/CJK fonts and untouched bytes stay exactly as they were.
 *
 * Committed edits render in every mode; the discovery hit boxes (text lines and painted
 * images) only exist while `editMode` is on, and nothing is interactive when `readOnly`.
 */
export function EditPdfLayer({
  doc,
  pageNo,
  geom,
  scale,
  editMode,
  edits,
  readOnly,
  onCommit,
}: {
  doc: PDFDocumentProxy
  /** 1-based PDF page number */
  pageNo: number
  geom: PageGeom
  scale: number
  editMode: boolean
  /** only this page's edits */
  edits: readonly PageContentEdit[]
  readOnly: boolean
  onCommit: (edit: PageContentEdit) => void
}): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /** Discovered lines and painted images of the page; filled only while editing */
  const [blocks, setBlocks] = useState<EditableTextBlock[]>([])
  const [images, setImages] = useState<EditablePageImage[]>([])
  /** True while the async text/operator discovery below is in flight */
  const [isScanning, setIsScanning] = useState(false)

  /** Images on the page: discovered PDF images plus any duplicated/added image edits */
  const allImages = useMemo<EditablePageImage[]>(() => {
    const list = [...images]
    for (const edit of edits) {
      if (edit.kind === 'image' && edit.image !== '') {
        if (!list.some((img) => img.id === edit.id)) {
          list.push({
            id: edit.id,
            pageIndex: edit.pageIndex,
            origRect: edit.origRect,
          })
        }
      }
    }
    return list
  }, [images, edits])

  const [draft, setDraft] = useState<Draft | null>(null)
  const [textDrag, setTextDrag] = useState<TextDrag | null>(null)
  const [imageDrag, setImageDrag] = useState<ImageDrag | null>(null)
  const [imageResize, setImageResize] = useState<ImageResize | null>(null)
  /** Selected page image, for the handles and the action bar */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** Image waiting for the replace-image file picker (a ref: the picker fires long after the click) */
  const replaceTargetRef = useRef<EditablePageImage | null>(null)

  const interactive = editMode && !readOnly

  // ── Geometry helpers ──

  /** The rendered page canvas, so colors and crops come from what the user actually sees */
  const pageCanvas = (): HTMLCanvasElement | null =>
    rootRef.current?.parentElement?.querySelector('canvas') ?? null

  /** PDF rect → display box (scale=1), the unit displayBoxToPdf expects */
  const displayBox = (rect: Rect): CanvasBox => pdfRectToCss(geom, rect, 1)

  /** Display box → absolute CSS box */
  const cssBox = (box: CanvasBox): CSSProperties => ({
    left: box.left * scale,
    top: box.top * scale,
    width: box.width * scale,
    height: box.height * scale,
  })

  const liveTransform = (id: string): string | undefined => {
    if (textDrag?.block.id === id && textDrag.moved) {
      return `translate(${textDrag.dx * scale}px, ${textDrag.dy * scale}px)`
    }
    if (imageDrag?.image.id === id && imageDrag.moved) {
      return `translate(${imageDrag.dx * scale}px, ${imageDrag.dy * scale}px)`
    }
    if (imageResize?.image.id === id) {
      const { start, box } = imageResize
      if (start.width <= 0 || start.height <= 0) return undefined
      const kx = box.width / start.width
      const ky = box.height / start.height
      // Origin is the element's own top-left, so the scale is relative to it and the
      // translate is just the corner moving from the start box to the live box
      return `translate(${(box.left - start.left) * scale}px, ${
        (box.top - start.top) * scale
      }px) scale(${kx}, ${ky})`
    }
    return undefined
  }

  /** Base style plus the live drag/resize transform, so previews follow the pointer */
  const withLive = (id: string, style: CSSProperties): CSSProperties => {
    const transform = liveTransform(id)
    return transform ? { ...style, transform, transformOrigin: '0 0' } : style
  }

  const textEditOf = (id: string): TextContentEdit | undefined =>
    edits.find((e): e is TextContentEdit => e.id === id && e.kind === 'text')

  const imageEditOf = (id: string): ImageContentEdit | undefined =>
    edits.find((e): e is ImageContentEdit => e.id === id && e.kind === 'image')

  // ── Building edits ──

  /**
   * Text edit for a dragged block: the block's own text and styling, colors sampled from the
   * page, and a bitmap anchored at the box the user dropped it on.
   */
  const createTextEdit = (block: EditableTextBlock, box: CanvasBox): TextContentEdit | null =>
    buildTextEdit(geom, block, pageCanvas(), block.text, { scale, at: box })

  /**
   * The edit an image gesture works from: the existing one, else a fresh crop of the rendered
   * image with the page background behind it. Null when the canvas cannot provide the crop —
   * without the bitmap the gesture would leave a patch and nothing to draw back.
   */
  const ensureImageEdit = (image: EditablePageImage): ImageContentEdit | null => {
    const existing = imageEditOf(image.id)
    if (existing?.image) return existing
    const canvas = pageCanvas()
    if (!canvas) return null
    const css = pdfRectToCss(geom, image.origRect, scale)
    const cropped = cropCanvasImage(canvas, css)
    if (!cropped) return null
    return {
      id: image.id,
      pageIndex: image.pageIndex,
      origRect: image.origRect,
      rect: existing?.rect ?? image.origRect,
      bgColor: sampleCanvasColors(canvas, css).bgColor,
      kind: 'image',
      image: cropped,
    }
  }

  // ── Text: inline editor ──

  const openEditor = (block: EditableTextBlock) => {
    const existing = textEditOf(block.id)
    let base = existing
    if (!base) {
      const canvas = pageCanvas()
      const colors = canvas
        ? sampleCanvasColors(canvas, pdfRectToCss(geom, block.origRect, scale))
        : { bgColor: FALLBACK_BG, color: FALLBACK_FG }
      base = {
        id: block.id,
        pageIndex: block.pageIndex,
        origRect: block.origRect,
        rect: block.origRect,
        bgColor: colors.bgColor,
        kind: 'text',
        text: block.text,
        fontSize: clampFont(block.fontSize),
        bold: block.bold,
        italic: block.italic,
        underline: block.underline ?? false,
        color: colors.color,
        image: '',
      }
    }
    setSelectedId(null)
    setDraft({
      base,
      box: displayBox(base.rect),
      text: base.text,
      fontSize: clampFont(base.fontSize),
      bold: base.bold,
      italic: base.italic,
      underline: base.underline ?? false,
      color: base.color,
      bgColor: base.bgColor,
    })
  }

  const applyDraft = () => {
    const d = draft
    if (!d) return
    setDraft(null)
    const rendered = d.text.trim()
      ? renderTextBox(d.text, d.fontSize, d.color, {
          bold: d.bold,
          italic: d.italic,
          underline: d.underline,
          bgColor: d.bgColor,
        })
      : null
    if (!rendered) {
      // Nothing renderable left: commit the deletion, leaving only the whiteout patch
      onCommit({ ...d.base, text: '', image: '', underline: d.underline })
      return
    }
    onCommit({
      ...d.base,
      text: d.text,
      fontSize: d.fontSize,
      bold: d.bold,
      italic: d.italic,
      underline: d.underline,
      color: d.color,
      bgColor: d.bgColor,
      image: rendered.image,
      // Anchor the bitmap's top-left at the editor box: growing text grows down and right
      rect: displayBoxToPdf(geom, {
        left: d.box.left,
        top: d.box.top,
        width: rendered.width,
        height: rendered.height,
      }),
    })
  }

  const deleteDraft = () => {
    const d = draft
    if (!d) return
    setDraft(null)
    onCommit({ ...d.base, text: '', image: '' })
  }

  // ── Text: drag to move, click to edit ──

  const textDown = (e: ReactPointerEvent<HTMLDivElement>, block: EditableTextBlock, rect: Rect) => {
    if (e.button !== 0) return
    // Without this the page underneath starts a text selection instead of a drag
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedId(null)
    setTextDrag({
      block,
      rect,
      origin: [e.clientX, e.clientY],
      dx: 0,
      dy: 0,
      moved: false,
      preview: null,
    })
  }

  const textMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = textDrag
    if (!d) return
    const dx = (e.clientX - d.origin[0]) / scale
    const dy = (e.clientY - d.origin[1]) / scale
    if (!d.moved && Math.hypot(dx, dy) * scale < MIN_DRAG_PX) return
    // A block without an edit needs a live bitmap: without one the text stays on the canvas
    // while only the invisible hit box moves
    const preview =
      d.preview ?? (textEditOf(d.block.id) ? null : createTextEdit(d.block, displayBox(d.rect)))
    setTextDrag({ ...d, dx, dy, moved: true, preview })
  }

  const textUp = () => {
    const d = textDrag
    setTextDrag(null)
    if (!d) return
    if (!d.moved) {
      openEditor(d.block)
      return
    }
    const start = displayBox(d.rect)
    const moved: CanvasBox = { ...start, left: start.left + d.dx, top: start.top + d.dy }
    const existing = textEditOf(d.block.id)
    if (existing) {
      onCommit({ ...existing, rect: displayBoxToPdf(geom, moved) })
      return
    }
    // The preview was built at drag start, so translate its own rect: it already carries the
    // rendered bitmap's size, which the source hit box does not
    if (d.preview) {
      const start = displayBox(d.preview.rect)
      onCommit({
        ...d.preview,
        rect: displayBoxToPdf(geom, {
          ...start,
          left: start.left + d.dx,
          top: start.top + d.dy,
        }),
      })
      return
    }
    const created = createTextEdit(d.block, moved)
    if (created) onCommit(created)
  }

  // ── Images: select, drag, resize, replace, delete ──

  const imageDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    image: EditablePageImage,
    rect: Rect,
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelectedId(image.id)
    setImageDrag({
      image,
      rect,
      origin: [e.clientX, e.clientY],
      dx: 0,
      dy: 0,
      moved: false,
      preview: null,
    })
  }

  const imageMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = imageDrag
    if (!d) return
    const dx = (e.clientX - d.origin[0]) / scale
    const dy = (e.clientY - d.origin[1]) / scale
    if (!d.moved && Math.hypot(dx, dy) * scale < MIN_DRAG_PX) return
    // Crop on first movement (not on every click) so the bitmap visibly follows the pointer
    const preview = d.preview ?? (imageEditOf(d.image.id) ? null : ensureImageEdit(d.image))
    setImageDrag({ ...d, dx, dy, moved: true, preview })
  }

  const imageUp = () => {
    const d = imageDrag
    setImageDrag(null)
    // A sub-3px drag is a click: it only selects, no edit is created
    if (!d || !d.moved) return
    const base = imageEditOf(d.image.id) ?? d.preview ?? ensureImageEdit(d.image)
    if (!base) return
    const start = displayBox(d.rect)
    const moved: CanvasBox = { ...start, left: start.left + d.dx, top: start.top + d.dy }
    onCommit({ ...base, rect: displayBoxToPdf(geom, moved) })
  }

  const handleDown = (
    e: ReactPointerEvent<HTMLSpanElement>,
    image: EditablePageImage,
    corner: number,
    box: CanvasBox,
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setImageResize({
      image,
      corner,
      start: box,
      box,
      preview: imageEditOf(image.id) ? null : ensureImageEdit(image),
    })
  }

  const handleMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const r = imageResize
    const root = rootRef.current
    if (!r || !root) return
    const rootBox = root.getBoundingClientRect()
    const px = (e.clientX - rootBox.left) / scale
    const py = (e.clientY - rootBox.top) / scale
    const { start, corner } = r
    // The opposite corner stays put while the dragged one follows the pointer
    const fx = corner % 2 === 0 ? start.left + start.width : start.left
    const fy = corner < 2 ? start.top + start.height : start.top
    let width: number
    let height: number
    if (e.shiftKey) {
      // Free resize
      width = Math.max(MIN_BOX_PX, Math.abs(px - fx))
      height = Math.max(MIN_BOX_PX, Math.abs(py - fy))
    } else {
      // Aspect ratio preserved: the dominant axis sets the scale
      const k = Math.max(
        Math.abs(px - fx) / Math.max(start.width, 1),
        Math.abs(py - fy) / Math.max(start.height, 1),
        MIN_BOX_PX / Math.max(start.width, start.height),
      )
      width = start.width * k
      height = start.height * k
    }
    setImageResize({
      ...r,
      box: {
        left: corner % 2 === 0 ? fx - width : fx,
        top: corner < 2 ? fy - height : fy,
        width,
        height,
      },
    })
  }

  const handleUp = () => {
    const r = imageResize
    setImageResize(null)
    if (!r) return
    if (
      Math.abs(r.box.width - r.start.width) < MIN_DRAG_PX &&
      Math.abs(r.box.height - r.start.height) < MIN_DRAG_PX
    ) {
      return
    }
    const base = imageEditOf(r.image.id) ?? r.preview ?? ensureImageEdit(r.image)
    if (!base) return
    onCommit({ ...base, rect: displayBoxToPdf(geom, r.box) })
  }

  const copyImage = useCallback(
    async (image: EditablePageImage) => {
      const base = ensureImageEdit(image)
      if (!base || !base.image) return
      try {
        const byteChars = atob(base.image)
        const byteNumbers = new Uint8Array(byteChars.length)
        for (let i = 0; i < byteChars.length; i++) {
          byteNumbers[i] = byteChars.charCodeAt(i)
        }
        const blob = new Blob([byteNumbers], { type: 'image/png' })
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        }
      } catch {
        // Ignore clipboard write failure
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edits, geom, scale],
  )

  const duplicateImage = useCallback(
    (image: EditablePageImage) => {
      const base = ensureImageEdit(image)
      if (!base || !base.image) return
      const currentBox = displayBox(base.rect)
      const offset = 20
      const dupId = `img-dup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const duplicateEdit: ImageContentEdit = {
        id: dupId,
        pageIndex: base.pageIndex,
        origRect: [0, 0, 0, 0],
        rect: displayBoxToPdf(geom, {
          left: currentBox.left + offset,
          top: currentBox.top + offset,
          width: currentBox.width,
          height: currentBox.height,
        }),
        bgColor: '',
        kind: 'image',
        image: base.image,
      }
      onCommit(duplicateEdit)
      setSelectedId(dupId)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edits, geom, scale, onCommit],
  )

  const deleteImage = useCallback(
    (image: EditablePageImage) => {
      const base = ensureImageEdit(image)
      if (!base) return
      setSelectedId(null)
      onCommit({ ...base, image: '' })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edits, geom, scale, onCommit],
  )

  const replaceImage = async (image: EditablePageImage, file: File) => {
    const base = ensureImageEdit(image)
    if (!base) return
    try {
      const png = await imageFileToPng(file)
      if (!png.image) return
      // Fit the replacement inside the existing box at its own aspect ratio, centered
      const current = displayBox(base.rect)
      const k = Math.min(
        current.width / Math.max(png.width, 1),
        current.height / Math.max(png.height, 1),
      )
      const width = png.width * k
      const height = png.height * k
      onCommit({
        ...base,
        image: png.image,
        rect: displayBoxToPdf(geom, {
          left: current.left + (current.width - width) / 2,
          top: current.top + (current.height - height) / 2,
          width,
          height,
        }),
      })
    } catch {
      // Undecodable file: leave the page untouched rather than half-replacing the image
    }
  }

  const pickReplacement = (image: EditablePageImage) => {
    replaceTargetRef.current = image
    const input = fileRef.current
    if (!input) return
    // Reset so picking the same file twice still fires a change event
    input.value = ''
    input.click()
  }

  // ── Discovery ──

  useEffect(() => {
    if (!editMode) {
      setIsScanning(false)
      setBlocks([])
      setImages([])
      setDraft(null)
      setTextDrag(null)
      setImageDrag(null)
      setImageResize(null)
      setSelectedId(null)
      return
    }
    let cancelled = false
    // Only the pages on screen are scanned, and only while the mode is on: a short,
    // non-blocking cue is enough, the document-open loader stays where it is
    setIsScanning(true)
    void (async () => {
      try {
        const page = await doc.getPage(pageNo)
        // Both lists come from what pdf.js already decoded; no extra rendering
        const [content, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()])
        if (cancelled) return
        setBlocks(extractPageTextBlocks(pageNo - 1, content.items, content.styles))
        setImages(extractPageImages(pageNo - 1, ops))
      } catch {
        // A page pdf.js cannot describe is simply not editable
        if (cancelled) return
        setBlocks([])
        setImages([])
      } finally {
        // A cancelled run is followed by a fresh one, which owns the spinner from here on
        if (!cancelled) setIsScanning(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc, pageNo, editMode])

  // A new page (or a reloaded document) starts with nothing selected or half-edited
  useEffect(() => {
    setDraft(null)
    setTextDrag(null)
    setImageDrag(null)
    setImageResize(null)
    setSelectedId(null)
  }, [pageNo])

  // Keyboard actions when an image is selected (copy, duplicate, delete)
  useEffect(() => {
    if (!interactive || !selectedId || draft) return
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const currentSelected = allImages.find((img) => img.id === selectedId)
      if (!currentSelected) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteImage(currentSelected)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        void copyImage(currentSelected)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        duplicateImage(currentSelected)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [interactive, selectedId, draft, allImages, deleteImage, copyImage, duplicateImage])

  // ── Render ──

  const selected = selectedId ? (allImages.find((image) => image.id === selectedId) ?? null) : null
  const selectedRect = selected ? (imageEditOf(selected.id)?.rect ?? selected.origRect) : null
  const editorCss = draft ? cssBox(draft.box) : null
  const editorPatch = draft ? renderSolidPatch(draft.bgColor) : ''

  return (
    <div className="pdf-content-edit-layer" ref={rootRef}>
      {/* Committed edits: the whiteout patch always, the replacement bitmap while anything is
          still visible; these render in every mode so the page preview matches the save. All
          patches go first, matching the payload, so overlapping edits stack the same way. */}
      {edits.map((edit) => {
        const hasOrig =
          edit.origRect &&
          edit.origRect[2] > edit.origRect[0] &&
          edit.origRect[3] > edit.origRect[1]
        if (!hasOrig || !edit.bgColor) return null
        const patch = renderSolidPatch(edit.bgColor)
        return (
          patch !== '' && (
            <img
              key={edit.id}
              className="pdf-content-edit-patch"
              src={`data:image/png;base64,${patch}`}
              alt=""
              style={pdfRectToCss(geom, edit.origRect, scale)}
            />
          )
        )
      })}
      {edits.map((edit) => {
        // The open editor already covers this block; a second bitmap would double the text
        const editing = draft?.base.id === edit.id
        const visible = !editing && edit.image !== '' && (edit.kind === 'image' || edit.text !== '')
        return (
          visible && (
            <img
              key={edit.id}
              className="pdf-content-edit-img"
              src={`data:image/png;base64,${edit.image}`}
              alt=""
              style={withLive(edit.id, pdfRectToCss(geom, edit.rect, scale))}
            />
          )
        )
      })}

      {/* First drag/resize of an unedited block or image: patch the original and float the new bitmap */}
      {(textDrag?.preview || imageDrag?.preview || imageResize?.preview) &&
        (() => {
          const edit = textDrag?.preview ?? imageDrag?.preview ?? imageResize!.preview!
          const hasOrig =
            edit.origRect &&
            edit.origRect[2] > edit.origRect[0] &&
            edit.origRect[3] > edit.origRect[1]
          const patch = hasOrig && edit.bgColor ? renderSolidPatch(edit.bgColor) : ''
          return (
            <>
              {patch !== '' && (
                <img
                  className="pdf-content-edit-patch"
                  src={`data:image/png;base64,${patch}`}
                  alt=""
                  style={pdfRectToCss(geom, edit.origRect, scale)}
                />
              )}
              <img
                className="pdf-content-edit-img"
                src={`data:image/png;base64,${edit.image}`}
                alt=""
                style={withLive(edit.id, pdfRectToCss(geom, edit.rect, scale))}
              />
            </>
          )
        })()}

      {/* Text hit boxes: one per discovered line, skipping lines the user deleted. Hidden while
          an editor is open so typing cannot be lost by clicking another block. */}
      {interactive &&
        !draft &&
        blocks.map((block) => {
          const edit = textEditOf(block.id)
          if (edit?.text === '') return null
          const rect = edit ? edit.rect : block.origRect
          return (
            <div
              key={block.id}
              className="pdf-content-block"
              title={block.text}
              style={withLive(block.id, pdfRectToCss(geom, rect, scale))}
              onPointerDown={(e) => textDown(e, block, rect)}
              onPointerMove={textMove}
              onPointerUp={textUp}
              onPointerCancel={() => setTextDrag(null)}
            />
          )
        })}

      {/* Image hit boxes: one per painted image, skipping deleted ones */}
      {interactive &&
        !draft &&
        allImages.map((image) => {
          const edit = imageEditOf(image.id)
          if (edit && edit.image === '') return null
          const rect = edit ? edit.rect : image.origRect
          return (
            <div
              key={image.id}
              className={`pdf-content-image-box${
                image.id === selectedId ? ' pdf-content-image-box-selected' : ''
              }`}
              style={withLive(image.id, pdfRectToCss(geom, rect, scale))}
              onPointerDown={(e) => imageDown(e, image, rect)}
              onPointerMove={imageMove}
              onPointerUp={imageUp}
              onPointerCancel={() => setImageDrag(null)}
            />
          )
        })}

      {/* Selected image: corner handles plus replace/delete */}
      {interactive &&
        selected &&
        selectedRect &&
        (() => {
          const box =
            imageResize?.image.id === selected.id ? imageResize.box : displayBox(selectedRect)
          const corners: [number, number, string][] = [
            [box.left, box.top, 'nwse-resize'],
            [box.left + box.width, box.top, 'nesw-resize'],
            [box.left, box.top + box.height, 'nesw-resize'],
            [box.left + box.width, box.top + box.height, 'nwse-resize'],
          ]
          return (
            <>
              <div className="pdf-content-actionbar" style={getFloatingStyle(geom, scale, box)}>
                <button type="button" onClick={() => void copyImage(selected)}>
                  {t('copyImage')}
                </button>
                <span className="pdf-content-divider" aria-hidden="true" />
                <button type="button" onClick={() => duplicateImage(selected)}>
                  {t('duplicateImage')}
                </button>
                <span className="pdf-content-divider" aria-hidden="true" />
                <button type="button" onClick={() => pickReplacement(selected)}>
                  {t('replaceImage')}
                </button>
                <span className="pdf-content-divider" aria-hidden="true" />
                <button type="button" onClick={() => deleteImage(selected)}>
                  {t('deleteAnnotation')}
                </button>
              </div>
              {corners.map(([left, top, cursor], i) => (
                <span
                  key={i}
                  className="pdf-draw-handle pdf-content-handle"
                  style={{
                    position: 'absolute',
                    pointerEvents: 'auto',
                    left: left * scale,
                    top: top * scale,
                    cursor,
                    transform: 'translate(-50%, -50%)',
                  }}
                  onPointerDown={(e) => handleDown(e, selected, i, displayBox(selectedRect))}
                  onPointerMove={handleMove}
                  onPointerUp={handleUp}
                  onPointerCancel={() => setImageResize(null)}
                />
              ))}
            </>
          )
        })()}

      {/* Inline text editor over the block, with its mini toolbar above */}
      {interactive && draft && editorCss && (
        <>
          {editorPatch !== '' && (
            <img
              className="pdf-content-edit-patch"
              src={`data:image/png;base64,${editorPatch}`}
              alt=""
              style={editorCss}
            />
          )}
          <textarea
            className="pdf-content-editor-text"
            autoFocus
            value={draft.text}
            style={{
              ...editorCss,
              position: 'absolute',
              pointerEvents: 'auto',
              fontFamily: EDITOR_FONT,
              fontSize: draft.fontSize * scale,
              fontWeight: draft.bold ? 700 : 400,
              fontStyle: draft.italic ? 'italic' : 'normal',
              textDecoration: draft.underline ? 'underline' : 'none',
              color: draft.color,
              background: draft.bgColor,
            }}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setDraft(null)
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                // Enter applies, Shift+Enter keeps typing a new line (IME confirms excluded)
                e.preventDefault()
                applyDraft()
              } else if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
                e.preventDefault()
                setDraft((prev) => (prev ? { ...prev, bold: !prev.bold } : null))
              } else if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
                e.preventDefault()
                setDraft((prev) => (prev ? { ...prev, italic: !prev.italic } : null))
              } else if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U')) {
                e.preventDefault()
                setDraft((prev) => (prev ? { ...prev, underline: !prev.underline } : null))
              }
            }}
          />
          <div className="pdf-content-toolbar" style={getFloatingStyle(geom, scale, draft.box)}>
            <button
              type="button"
              onClick={() => setDraft({ ...draft, fontSize: clampFont(draft.fontSize - 1) })}
            >
              −
            </button>
            <input
              type="number"
              min={MIN_FONT}
              max={MAX_FONT}
              value={draft.fontSize}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v)) setDraft({ ...draft, fontSize: clampFont(v) })
              }}
            />
            <button
              type="button"
              onClick={() => setDraft({ ...draft, fontSize: clampFont(draft.fontSize + 1) })}
            >
              +
            </button>

            <span className="pdf-content-divider" aria-hidden="true" />

            <button
              type="button"
              className={draft.bold ? 'pdf-content-toggle-on' : undefined}
              style={{ fontWeight: 700 }}
              title="Bold (Ctrl+B)"
              onClick={() => setDraft({ ...draft, bold: !draft.bold })}
            >
              B
            </button>
            <button
              type="button"
              className={draft.italic ? 'pdf-content-toggle-on' : undefined}
              style={{ fontStyle: 'italic' }}
              title="Italic (Ctrl+I)"
              onClick={() => setDraft({ ...draft, italic: !draft.italic })}
            >
              I
            </button>
            <button
              type="button"
              className={draft.underline ? 'pdf-content-toggle-on' : undefined}
              style={{ textDecoration: 'underline' }}
              title="Underline (Ctrl+U)"
              onClick={() => setDraft({ ...draft, underline: !draft.underline })}
            >
              U
            </button>

            <span className="pdf-content-divider" aria-hidden="true" />

            <input
              type="color"
              value={draft.color}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
            />

            <span className="pdf-content-divider" aria-hidden="true" />

            <button type="button" onClick={deleteDraft}>
              {t('deleteAnnotation')}
            </button>

            <span className="pdf-content-divider" aria-hidden="true" />

            <button type="button" onClick={() => setDraft(null)}>
              {t('cancel')}
            </button>
            <button type="button" onClick={applyDraft}>
              {t('apply')}
            </button>
          </div>
        </>
      )}

      {/* Replace-image picker: one per page, opened from the selected image's action bar */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          const target = replaceTargetRef.current
          replaceTargetRef.current = null
          if (file && target) void replaceImage(target, file)
        }}
      />

      {/* Discovery is still running for this page: a small cue in the page's top-right corner,
          pointer-transparent so the text and image hit boxes stay usable underneath */}
      {editMode && isScanning && (
        <div className="pdf-content-scanning" role="status" title={t('loading')}>
          <span className="pdf-content-spinner" aria-hidden="true" />
        </div>
      )}
    </div>
  )
}
