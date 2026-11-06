import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { SavedSignatureItem } from '../shared/ipc'
import { cssRgb } from './DrawLayer'
import type { TFunc } from './i18n/locale'
import { DraggableModal } from './DraggableModal'
import { createQrSignature, defaultQrSignatureLayout, signaturePreviewSize } from './qr-signature'
import type { QrSignatureLayout } from './qr-signature'

const PAD_W = 420
const PAD_H = 150
/** Uploaded signature images are downscaled to this max dimension to bound file size */
const MAX_IMG = 1600
const PREVIEW_WIDTH = 4
const PREVIEW_HEIGHT = 4
export function fitPreview(layout: QrSignatureLayout, qrWidth: number): QrSignatureLayout {
  return { ...layout, qrX: Math.max(0, Math.min(layout.qrX, PREVIEW_WIDTH - qrWidth)) }
}

function maxSignatureScale(layout: QrSignatureLayout, primary: SavedSignatureItem) {
  const base = signaturePreviewSize(primary)
  return Math.max(
    0.35,
    Math.min(
      (PREVIEW_WIDTH - layout.signatureX) / base.width,
      (PREVIEW_HEIGHT - layout.signatureY) / base.height,
    ),
  )
}

/** Typed-signature font choices; families fall back across macOS/Windows system fonts.
    Each card previews the typed name in its font, so no localized labels are needed. */
const SIGN_FONTS: { id: string; family: string; italic?: boolean }[] = [
  {
    id: 'script',
    family: `"Snell Roundhand", "Segoe Script", "Brush Script MT", cursive`,
    italic: true,
  },
  { id: 'xingkai', family: `"Xingkai SC", "STXingkai", "KaiTi", "Kaiti SC", cursive` },
  { id: 'kaiti', family: `"Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", serif` },
  { id: 'songti', family: `"Songti SC", "SimSun", "Times New Roman", serif` },
]

/** Font size used when rasterizing a typed signature; large so the stamp stays crisp when scaled */
const TYPE_FONT_PX = 200

/** Signature strokes: pad pixel coords, scaled proportionally and y-flipped when placed on the page */
export interface SignatureStrokes {
  paths: number[][]
  width: number
  height: number
  color?: [number, number, number]
}

/** Confirmed signature awaiting placement: hand strokes (Ink) or a bitmap (Stamp) */
export type SignatureData =
  | ({ kind: 'strokes' } & SignatureStrokes)
  | {
      kind: 'image'
      /** base64 PNG, without the data: prefix */
      image: string
      width: number
      height: number
      qr?: boolean
      qrWithSignature?: boolean
    }

/** Decode + downscale an image file onto a canvas (null if it can't be decoded) */
async function fileToCanvas(file: File): Promise<HTMLCanvasElement | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('decode'))
      img.src = url
    })
    const k = Math.min(1, MAX_IMG / Math.max(img.naturalWidth, img.naturalHeight, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * k))
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Black & white: dark pixels → solid black, light pixels → transparent (with a soft
    ramp in between for antialiasing). Turns a photographed signature into a clean stamp. */
function toBlackAndWhite(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height
  const ctx = out.getContext('2d', { willReadFrequently: true })
  const srcCtx = src.getContext('2d', { willReadFrequently: true })
  if (!ctx || !srcCtx) return src
  const img = srcCtx.getImageData(0, 0, src.width, src.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
    const a = lum > 200 ? 0 : lum < 120 ? 255 : Math.round(((200 - lum) / 80) * 255)
    d[i] = 0
    d[i + 1] = 0
    d[i + 2] = 0
    d[i + 3] = Math.round((a * d[i + 3]!) / 255)
  }
  ctx.putImageData(img, 0, 0)
  return out
}

/** Rasterize typed text with the chosen font onto a tightly-cropped transparent canvas.
    The result goes through the image (Stamp) pipeline, so what you see in the font
    preview card is exactly what lands on the page — no stroke approximation. */
function textToImage(
  text: string,
  f: (typeof SIGN_FONTS)[number],
  color: [number, number, number],
): Extract<SignatureData, { kind: 'image' }> | null {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const font = `${f.italic ? 'italic ' : ''}${TYPE_FONT_PX}px ${f.family}`
  ctx.font = font
  const m = ctx.measureText(text)
  // Tight bounds from actual glyph extents; padding covers italic overhang and antialiasing
  const pad = Math.ceil(TYPE_FONT_PX * 0.08)
  const left = Math.ceil(m.actualBoundingBoxLeft) + pad
  const ascent = Math.ceil(m.actualBoundingBoxAscent) + pad
  canvas.width = left + Math.ceil(m.actualBoundingBoxRight) + pad
  canvas.height = ascent + Math.ceil(m.actualBoundingBoxDescent) + pad
  if (canvas.width < 2 || canvas.height < 2) return null
  // Resizing the canvas resets the context state, so the font must be set again
  ctx.font = font
  ctx.fillStyle = cssRgb(color)
  ctx.fillText(text, left, ascent)
  const base64 = canvas.toDataURL('image/png').split(',')[1]
  return base64
    ? { kind: 'image', image: base64, width: canvas.width, height: canvas.height }
    : null
}

function SavedPreview({ item }: { item: SavedSignatureItem }): ReactElement {
  if (item.kind === 'image' && item.image) {
    return <img src={`data:image/png;base64,${item.image}`} alt="" draggable={false} />
  }
  return (
    <svg viewBox={`0 0 ${item.width} ${item.height}`} aria-hidden="true">
      {(item.paths ?? []).map((path, index) => {
        const points: string[] = []
        for (let i = 0; i + 1 < path.length; i += 2) points.push(`${path[i]},${path[i + 1]}`)
        return (
          <polyline
            key={index}
            points={points.join(' ')}
            fill="none"
            stroke={cssRgb(item.color ?? [0, 0, 0])}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )
      })}
    </svg>
  )
}

/** Signature dialog: draw on a pad, type text, or upload an image; confirming enters placement mode */
export function SignatureDialog({
  color,
  t,
  onCancel,
  onConfirm,
}: {
  color: [number, number, number]
  t: TFunc
  onCancel: () => void
  onConfirm: (sig: SignatureData) => void
}): ReactElement {
  const [mode, setMode] = useState<'saved' | 'draw' | 'type' | 'image' | 'qr'>('saved')
  const [savedId, setSavedId] = useState('')
  const [qrLayout, setQrLayout] = useState<QrSignatureLayout | null>(null)
  const [qrPreview, setQrPreview] = useState<{
    key: string
    image: string
    width: number
    height: number
  } | null>(null)
  const [previewError, setPreviewError] = useState('')
  const stageRef = useRef<HTMLDivElement>(null)
  const resizeDragRef = useRef<{ pointerId: number; x: number; y: number; scale: number } | null>(
    null,
  )
  const previewDragRef = useRef<{
    target: 'signature' | 'qr'
    pointerId: number
    x: number
    y: number
    startX: number
    startY: number
  } | null>(null)
  const [qrName, setQrName] = useState('')
  const [qrIntent, setQrIntent] = useState('')
  const [qrRecipient, setQrRecipient] = useState('')
  const [qrError, setQrError] = useState(false)
  const [withPrimary, setWithPrimary] = useState(false)
  const [qrBusy, setQrBusy] = useState(false)
  const mountedRef = useRef(true)
  const [typed, setTyped] = useState('')
  const [fontIdx, setFontIdx] = useState(0)
  const [imgCanvas, setImgCanvas] = useState<HTMLCanvasElement | null>(null)
  const [bw, setBw] = useState(false)
  const [savedSigs, setSavedSigs] = useState<SavedSignatureItem[]>([])
  const [saveToVault, setSaveToVault] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pathsRef = useRef<number[][]>([])
  const curRef = useRef<number[] | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let canceled = false
    const getPrefs = window.pdfApi?.getPreferences
    if (!getPrefs) return
    void getPrefs()
      .then((prefs) => {
        if (!canceled) {
          if (Array.isArray(prefs?.signatures)) setSavedSigs(prefs.signatures)
          if (prefs?.profile?.fullName) setQrName((name) => name || prefs.profile!.fullName!.trim())
        }
      })
      .catch(() => {})
    return () => {
      canceled = true
    }
  }, [])

  /** Processed image + preview data URL, recomputed when the source or the B&W toggle changes */
  const processedImg = useMemo(() => {
    if (!imgCanvas) return null
    const canvas = bw ? toBlackAndWhite(imgCanvas) : imgCanvas
    return { canvas, url: canvas.toDataURL('image/png') }
  }, [imgCanvas, bw])

  const pickImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const canvas = await fileToCanvas(file)
    if (canvas) setImgCanvas(canvas)
  }

  const redraw = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = cssRgb(color)
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const p of pathsRef.current) {
      ctx.beginPath()
      ctx.moveTo(p[0]!, p[1]!)
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!)
      ctx.stroke()
    }
  }

  useEffect(redraw, [color, mode])

  const pos = (e: ReactPointerEvent): [number, number] => {
    const box = e.currentTarget.getBoundingClientRect()
    return [e.clientX - box.left, e.clientY - box.top]
  }

  const down = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    curRef.current = pos(e)
    pathsRef.current = [...pathsRef.current, curRef.current]
  }
  const move = (e: ReactPointerEvent) => {
    if (!curRef.current) return
    const [x, y] = pos(e)
    curRef.current.push(x, y)
    redraw()
  }
  const up = () => {
    curRef.current = null
  }

  const clear = () => {
    pathsRef.current = []
    redraw()
  }

  const maybePersistToVault = (sig: SignatureData, labelHint: string) => {
    if (!saveToVault) return
    const api = window.pdfApi
    if (!api?.getPreferences || !api?.setPreferences) return
    const setPreferences = api.setPreferences
    void api
      .getPreferences()
      .then((prefs) => {
        const list = Array.isArray(prefs.signatures) ? prefs.signatures : []
        const entry: SavedSignatureItem =
          sig.kind === 'strokes'
            ? {
                id: `sig-${Date.now()}`,
                label: labelHint || 'Signature',
                kind: 'strokes',
                paths: sig.paths,
                width: sig.width,
                height: sig.height,
                color,
                createdAt: Date.now(),
                isDefault: list.length === 0,
              }
            : {
                id: `sig-${Date.now()}`,
                label: labelHint || 'Signature',
                kind: 'image',
                image: sig.image,
                width: sig.width,
                height: sig.height,
                createdAt: Date.now(),
                isDefault: list.length === 0,
              }
        return setPreferences({ ...prefs, signatures: [...list, entry] })
      })
      .catch(() => {})
  }

  const applySavedSig = (item: SavedSignatureItem) => {
    if (item.kind === 'strokes' && item.paths && item.paths.length > 0) {
      onConfirm({
        kind: 'strokes',
        paths: item.paths,
        width: item.width,
        height: item.height,
        color: item.color,
      })
    } else if (item.kind === 'image' && item.image) {
      onConfirm({
        kind: 'image',
        image: item.image,
        width: item.width,
        height: item.height,
      })
    }
  }

  const primarySignature = savedSigs.find((item) => item.isDefault)
  const savedSelection =
    savedSigs.find((item) => item.id === savedId) ?? primarySignature ?? savedSigs[0]
  const previewKey = JSON.stringify([qrName, qrIntent, qrRecipient])
  const preview = qrPreview?.key === previewKey ? qrPreview : null
  const rawPositions = primarySignature
    ? (qrLayout ?? defaultQrSignatureLayout(primarySignature))
    : null
  const positions =
    rawPositions && preview && primarySignature
      ? fitPreview(rawPositions, preview.width / preview.height)
      : rawPositions

  useEffect(() => {
    if (mode !== 'qr' || !withPrimary || !primarySignature) return
    let canceled = false
    void createQrSignature(
      qrName.trim() || 'Name',
      qrIntent.trim() || 'Intent',
      qrRecipient.trim() || 'Recipient',
      new Date(),
    )
      .then((sig) => {
        if (!canceled && sig.kind === 'image')
          setQrPreview({ key: previewKey, image: sig.image, width: sig.width, height: sig.height })
      })
      .catch(() => {
        if (!canceled) setPreviewError(previewKey)
      })
    return () => {
      canceled = true
    }
  }, [mode, withPrimary, primarySignature, previewKey, qrName, qrIntent, qrRecipient])

  const movePreview = (target: 'signature' | 'qr', x: number, y: number) => {
    if (!primarySignature || !preview || !positions) return
    const signature = signaturePreviewSize(primarySignature, positions.signatureScale)
    const qrWidth = preview.width / preview.height
    const width = target === 'qr' ? qrWidth : signature.width
    const height = target === 'qr' ? 1 : signature.height
    setQrLayout({
      ...positions,
      [target === 'qr' ? 'qrX' : 'signatureX']: Math.max(0, Math.min(PREVIEW_WIDTH - width, x)),
      [target === 'qr' ? 'qrY' : 'signatureY']: Math.max(0, Math.min(PREVIEW_HEIGHT - height, y)),
    })
  }

  const resizeMax =
    primarySignature && preview && positions ? maxSignatureScale(positions, primarySignature) : 0.35
  const resizeSignature = (scale: number) => {
    if (!positions || !primarySignature || !preview) return
    setQrLayout({ ...positions, signatureScale: Math.max(0.35, Math.min(resizeMax, scale)) })
  }
  const resizePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!positions || !preview || e.button !== 0 || previewDragRef.current || resizeDragRef.current)
      return
    e.preventDefault()
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeDragRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      scale: positions.signatureScale ?? 1,
    }
  }
  const resizePointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = resizeDragRef.current
    const width = stageRef.current?.getBoundingClientRect().width
    if (!drag || drag.pointerId !== e.pointerId || !width || !primarySignature) return
    const base = signaturePreviewSize(primarySignature)
    const unit = width / PREVIEW_WIDTH
    const delta =
      ((e.clientX - drag.x) * base.width + (e.clientY - drag.y) * base.height) /
      (unit * (base.width ** 2 + base.height ** 2))
    resizeSignature(drag.scale + delta)
  }
  const resizePointerEnd = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeDragRef.current?.pointerId === e.pointerId) resizeDragRef.current = null
  }
  const previewPointerDown = (
    target: 'signature' | 'qr',
    e: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (!positions || e.button !== 0 || previewDragRef.current || resizeDragRef.current) return
    e.preventDefault()
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    previewDragRef.current = {
      target,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      startX: target === 'qr' ? positions.qrX : positions.signatureX,
      startY: target === 'qr' ? positions.qrY : positions.signatureY,
    }
  }
  const previewPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = previewDragRef.current
    const width = stageRef.current?.getBoundingClientRect().width
    if (!drag || drag.pointerId !== e.pointerId || !width) return
    const unit = width / PREVIEW_WIDTH
    movePreview(
      drag.target,
      drag.startX + (e.clientX - drag.x) / unit,
      drag.startY + (e.clientY - drag.y) / unit,
    )
  }
  const previewPointerEnd = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (previewDragRef.current?.pointerId === e.pointerId) previewDragRef.current = null
  }
  const previewKeyDown = (
    target: 'signature' | 'qr',
    e: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (!positions) return
    const delta = {
      ArrowLeft: [-0.1, 0],
      ArrowRight: [0.1, 0],
      ArrowUp: [0, -0.1],
      ArrowDown: [0, 0.1],
    }[e.key]
    if (!delta) return
    e.preventDefault()
    movePreview(
      target,
      (target === 'qr' ? positions.qrX : positions.signatureX) + delta[0]!,
      (target === 'qr' ? positions.qrY : positions.signatureY) + delta[1]!,
    )
  }

  const confirm = () => {
    if (mode === 'saved') {
      if (savedSelection) applySavedSig(savedSelection)
      return
    }
    if (mode === 'qr') {
      const name = qrName.trim()
      const intent = qrIntent.trim()
      const recipient = qrRecipient.trim()
      if (
        !name ||
        !intent ||
        !recipient ||
        qrBusy ||
        (withPrimary && (!primarySignature || !preview))
      )
        return
      setQrError(false)
      setQrBusy(true)
      void createQrSignature(
        name,
        intent,
        recipient,
        new Date(),
        withPrimary ? primarySignature : undefined,
        withPrimary ? (positions ?? undefined) : undefined,
      )
        .then((signature) => {
          if (mountedRef.current) onConfirm(signature)
        })
        .catch(() => {
          if (mountedRef.current) setQrError(true)
        })
        .finally(() => {
          if (mountedRef.current) setQrBusy(false)
        })
      return
    }
    if (mode === 'draw') {
      const paths = pathsRef.current.filter((p) => p.length >= 4)
      if (paths.length > 0) {
        const sig: SignatureData = { kind: 'strokes', paths, width: PAD_W, height: PAD_H }
        maybePersistToVault(sig, 'Drawn Signature')
        onConfirm(sig)
      }
      return
    }
    if (mode === 'image') {
      if (!processedImg) return
      const base64 = processedImg.canvas.toDataURL('image/png').split(',')[1]
      if (base64) {
        const sig: SignatureData = {
          kind: 'image',
          image: base64,
          width: processedImg.canvas.width,
          height: processedImg.canvas.height,
        }
        maybePersistToVault(sig, 'Uploaded Signature')
        onConfirm(sig)
      }
      return
    }
    const text = typed.trim()
    if (!text) return
    const sig = textToImage(text, SIGN_FONTS[fontIdx] ?? SIGN_FONTS[0]!, color)
    if (sig) {
      maybePersistToVault(sig, text)
      onConfirm(sig)
    }
  }

  const canConfirm =
    mode === 'draw' ||
    (mode === 'saved'
      ? !!savedSelection
      : mode === 'qr'
        ? !!(qrName.trim() && qrIntent.trim() && qrRecipient.trim()) &&
          !qrBusy &&
          (!withPrimary || !!(primarySignature && preview))
        : mode === 'image'
          ? processedImg !== null
          : typed.trim().length > 0)

  return (
    <DraggableModal
      className={`pdf-modal-signature${mode === 'qr' && withPrimary ? ' pdf-modal-signature-layout' : ''}`}
      onMaskClick={onCancel}
    >
      <div className="pdf-modal-title">{t('signTitle')}</div>
      <div className="pdf-sign-tabs">
        <button
          className={`pdf-sign-tab${mode === 'saved' ? ' active' : ''}`}
          onClick={() => setMode('saved')}
        >
          {t('signTitle')}
        </button>
        <button
          className={`pdf-sign-tab${mode === 'qr' ? ' active' : ''}`}
          onClick={() => setMode('qr')}
        >
          QR Signature
        </button>
        <button
          className={`pdf-sign-tab${mode === 'draw' ? ' active' : ''}`}
          onClick={() => setMode('draw')}
        >
          {t('signDraw')}
        </button>
        <button
          className={`pdf-sign-tab${mode === 'image' ? ' active' : ''}`}
          onClick={() => setMode('image')}
        >
          {t('signImage')}
        </button>
        <button
          className={`pdf-sign-tab${mode === 'type' ? ' active' : ''}`}
          onClick={() => setMode('type')}
        >
          {t('signType')}
        </button>
      </div>
      {mode === 'saved' && (
        <div className="pdf-sign-saved-bar">
          {savedSigs.length ? (
            <>
              <div className="pdf-sign-saved-chips">
                {savedSigs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`pdf-sign-saved-chip${savedSelection?.id === item.id ? ' active' : ''}`}
                    onClick={() => setSavedId(item.id)}
                  >
                    <span>{item.label}</span>
                    {item.isDefault && <span className="pdf-sign-saved-badge">Default</span>}
                  </button>
                ))}
              </div>
              {savedSelection && (
                <div className="pdf-sign-saved-preview">
                  <SavedPreview item={savedSelection} />
                </div>
              )}
            </>
          ) : (
            <div className="pdf-sign-hint">No saved signatures in E-Sign Vault.</div>
          )}
        </div>
      )}
      {mode === 'qr' && (
        <div className="pdf-sign-qr-layout">
          <div className="pdf-sign-qr-fields">
            <label>
              Name
              <input
                className="pdf-modal-input"
                value={qrName}
                maxLength={120}
                onChange={(e) => setQrName(e.target.value)}
              />
            </label>
            <label>
              Intent
              <input
                className="pdf-modal-input"
                value={qrIntent}
                maxLength={100}
                onChange={(e) => setQrIntent(e.target.value)}
              />
            </label>
            <label>
              Recipient
              <input
                className="pdf-modal-input"
                value={qrRecipient}
                maxLength={100}
                onChange={(e) => setQrRecipient(e.target.value)}
              />
            </label>
            <label className="pdf-sign-switch">
              <input
                type="checkbox"
                role="switch"
                checked={withPrimary}
                disabled={!primarySignature || qrBusy}
                onChange={(e) => setWithPrimary(e.target.checked)}
              />
              <span className="pdf-sign-switch-track" aria-hidden="true" />
              With primary signature
            </label>
            {withPrimary && (
              <div className="pdf-sign-preview-caption">Drag items or resize the signature</div>
            )}
            {!primarySignature && (
              <div className="pdf-sign-hint">Set a primary signature in E-Sign Vault first.</div>
            )}
            {qrError && (
              <div role="alert">
                Could not create QR signature. Check your primary signature or try shorter details.
              </div>
            )}
          </div>
          {withPrimary && primarySignature && positions && (
            <div className="pdf-sign-qr-preview">
              <div className="pdf-sign-layout-stage" ref={stageRef}>
                {(() => {
                  const size = signaturePreviewSize(primarySignature, positions.signatureScale)
                  return (
                    <>
                      <button
                        type="button"
                        className="pdf-sign-layout-item"
                        aria-label="Move primary signature"
                        style={{
                          left: `${(positions.signatureX / PREVIEW_WIDTH) * 100}%`,
                          top: `${(positions.signatureY / PREVIEW_HEIGHT) * 100}%`,
                          width: `${(size.width / PREVIEW_WIDTH) * 100}%`,
                          height: `${(size.height / PREVIEW_HEIGHT) * 100}%`,
                        }}
                        onPointerDown={(e) => previewPointerDown('signature', e)}
                        onPointerMove={previewPointerMove}
                        onPointerUp={previewPointerEnd}
                        onPointerCancel={previewPointerEnd}
                        onLostPointerCapture={previewPointerEnd}
                        onDragStart={(e) => e.preventDefault()}
                        onKeyDown={(e) => previewKeyDown('signature', e)}
                      >
                        <SavedPreview item={primarySignature} />
                      </button>
                      {preview && (
                        <button
                          type="button"
                          role="slider"
                          className="pdf-sign-resize-handle"
                          aria-label="Resize primary signature"
                          aria-valuemin={35}
                          aria-valuemax={Math.round(
                            Math.max(resizeMax, positions.signatureScale ?? 1) * 100,
                          )}
                          aria-valuenow={Math.round((positions.signatureScale ?? 1) * 100)}
                          aria-valuetext={`${Math.round((positions.signatureScale ?? 1) * 100)}%`}
                          style={{
                            left: `${((positions.signatureX + size.width) / PREVIEW_WIDTH) * 100}%`,
                            top: `${((positions.signatureY + size.height) / PREVIEW_HEIGHT) * 100}%`,
                          }}
                          onPointerDown={resizePointerDown}
                          onPointerMove={resizePointerMove}
                          onPointerUp={resizePointerEnd}
                          onPointerCancel={resizePointerEnd}
                          onLostPointerCapture={resizePointerEnd}
                          onKeyDown={(e) => {
                            const delta =
                              e.key === 'ArrowRight' || e.key === 'ArrowUp'
                                ? 0.05
                                : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
                                  ? -0.05
                                  : 0
                            if (delta) {
                              e.preventDefault()
                              resizeSignature((positions.signatureScale ?? 1) + delta)
                            }
                          }}
                        />
                      )}
                    </>
                  )
                })()}
                {preview && (
                  <button
                    type="button"
                    className="pdf-sign-layout-item pdf-sign-layout-qr"
                    aria-label="Move QR and details"
                    style={{
                      left: `${(positions.qrX / PREVIEW_WIDTH) * 100}%`,
                      top: `${(positions.qrY / PREVIEW_HEIGHT) * 100}%`,
                      width: `${(preview.width / preview.height / PREVIEW_WIDTH) * 100}%`,
                      height: `${100 / PREVIEW_HEIGHT}%`,
                    }}
                    onPointerDown={(e) => previewPointerDown('qr', e)}
                    onPointerMove={previewPointerMove}
                    onPointerUp={previewPointerEnd}
                    onPointerCancel={previewPointerEnd}
                    onLostPointerCapture={previewPointerEnd}
                    onDragStart={(e) => e.preventDefault()}
                    onKeyDown={(e) => previewKeyDown('qr', e)}
                  >
                    <img src={`data:image/png;base64,${preview.image}`} alt="" draggable={false} />
                  </button>
                )}
              </div>
              {!preview &&
                (previewError === previewKey ? (
                  <div role="alert">Could not prepare preview.</div>
                ) : (
                  <div className="pdf-sign-hint">Preparing preview…</div>
                ))}
            </div>
          )}
        </div>
      )}
      {mode === 'draw' && (
        <canvas
          ref={canvasRef}
          className="pdf-sign-pad"
          width={PAD_W}
          height={PAD_H}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      )}
      {mode === 'type' && (
        <>
          <input
            className="pdf-modal-input"
            value={typed}
            placeholder={t('signTypePlaceholder')}
            autoFocus
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
          <div className="pdf-sign-fontgrid">
            {SIGN_FONTS.map((f, i) => (
              <button
                key={f.id}
                className={`pdf-sign-fontcard${i === fontIdx ? ' active' : ''}`}
                style={{
                  color: cssRgb(color),
                  fontFamily: f.family,
                  fontStyle: f.italic ? 'italic' : 'normal',
                }}
                onClick={() => setFontIdx(i)}
              >
                {typed || t('signTypePlaceholder')}
              </button>
            ))}
          </div>
        </>
      )}
      {mode === 'image' && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => void pickImage(e)}
          />
          {processedImg ? (
            <div className="pdf-sign-imgbox" onClick={() => fileRef.current?.click()}>
              <img className="pdf-sign-img" src={processedImg.url} alt="" />
            </div>
          ) : (
            <button
              className="pdf-sign-imgbox pdf-sign-imgbox-empty"
              onClick={() => fileRef.current?.click()}
            >
              <span className="pdf-sign-imgplus">+</span>
              {t('signAddImage')}
            </button>
          )}
          <label className={`pdf-sign-bw${imgCanvas ? '' : ' disabled'}`}>
            <input
              type="checkbox"
              checked={bw}
              disabled={!imgCanvas}
              onChange={(e) => setBw(e.target.checked)}
            />
            {t('signBw')}
          </label>
        </>
      )}
      <div className="pdf-modal-actions">
        {mode === 'draw' && (
          <button className="pdf-modal-btn" onClick={clear}>
            {t('signClear')}
          </button>
        )}
        {mode === 'image' && imgCanvas && (
          <button
            className="pdf-modal-btn"
            onClick={() => {
              setImgCanvas(null)
              setBw(false)
            }}
          >
            {t('signClear')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {mode !== 'qr' && mode !== 'saved' && (
          <label className="pdf-sign-bw" style={{ marginRight: 8 }}>
            <input
              type="checkbox"
              checked={saveToVault}
              onChange={(e) => setSaveToVault(e.target.checked)}
            />
            Save to Vault
          </label>
        )}
        <button type="button" className="pdf-modal-btn" onClick={onCancel}>
          {t('cancel')}
        </button>
        <button
          type="button"
          className="pdf-modal-btn primary"
          disabled={!canConfirm}
          onClick={confirm}
        >
          {t('signPlace')}
        </button>
      </div>
    </DraggableModal>
  )
}
