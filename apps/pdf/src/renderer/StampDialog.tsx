import { useState, useRef, useEffect } from 'react'
import type { ReactElement } from 'react'
import { DEFAULT_HEADER_FOOTER, DEFAULT_WATERMARK } from './stamps'
import type { HeaderFooterConfig, WatermarkConfig } from './stamps'
import type { TFunc } from './i18n/locale'
import { DraggableModal } from './DraggableModal'

const WM_COLORS = ['#d0342c', '#8a8a8a', '#2b66ff', '#217346']

/** Watermark & Header/Footer config dialog; draggable, larger preview sheet, adaptive multi-text and center layout */
export function StampDialog({
  t,
  onCancel,
  onApply,
}: {
  t: TFunc
  onCancel: () => void
  onApply: (wm: WatermarkConfig | null, hf: HeaderFooterConfig | null) => void
}): ReactElement {
  const [tab, setTab] = useState<'watermark' | 'hf'>('watermark')
  const [wm, setWm] = useState<WatermarkConfig>(DEFAULT_WATERMARK)
  const [hf, setHf] = useState<HeaderFooterConfig>(DEFAULT_HEADER_FOOTER)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)

  const hfUsed =
    hf.pageNumber ||
    [
      hf.headerLeft,
      hf.headerCenter,
      hf.headerRight,
      hf.footerLeft,
      hf.footerCenter,
      hf.footerRight,
    ].some((s) => s.trim())
  const canApply = wm.text.trim().length > 0 || hfUsed

  useEffect(() => {
    if (tab !== 'watermark') return
    const canvas = previewCanvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = 240
    const h = 324
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    // Paper sheet background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)

    // Subtle mock document content to show realistic page context
    ctx.fillStyle = '#e2e8f0'
    const mockLines = [
      { x: 24, y: 30, w: 90, h: 8 },
      { x: 24, y: 50, w: 192, h: 4 },
      { x: 24, y: 60, w: 180, h: 4 },
      { x: 24, y: 70, w: 190, h: 4 },
      { x: 24, y: 80, w: 130, h: 4 },
      { x: 24, y: 102, w: 192, h: 4 },
      { x: 24, y: 112, w: 184, h: 4 },
      { x: 24, y: 122, w: 192, h: 4 },
      { x: 24, y: 144, w: 192, h: 4 },
      { x: 24, y: 154, w: 170, h: 4 },
      { x: 24, y: 176, w: 192, h: 4 },
      { x: 24, y: 186, w: 192, h: 4 },
      { x: 24, y: 196, w: 140, h: 4 },
      { x: 24, y: 218, w: 192, h: 4 },
      { x: 24, y: 228, w: 176, h: 4 },
      { x: 24, y: 238, w: 188, h: 4 },
    ]
    for (const m of mockLines) {
      ctx.fillRect(m.x, m.y, m.w, m.h)
    }

    const rawText = wm.text.trim() || t('watermarkPlaceholder')
    const lines = rawText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (lines.length === 0) return

    ctx.save()
    ctx.fillStyle = wm.color
    ctx.globalAlpha = Math.max(wm.opacity, 0.2)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const isTile = wm.layout === 'tile'
    if (!isTile) {
      ctx.translate(w / 2, h / 2)
      ctx.rotate((-wm.angle * Math.PI) / 180)
      let size = w * wm.sizeRatio
      ctx.font = `600 ${size}px -apple-system, "Segoe UI", sans-serif`
      const maxW = Math.hypot(w, h) * 0.8
      let maxLineW = 0
      for (const line of lines) {
        maxLineW = Math.max(maxLineW, ctx.measureText(line).width)
      }
      if (maxLineW > maxW) {
        size *= maxW / maxLineW
        ctx.font = `600 ${size}px -apple-system, "Segoe UI", sans-serif`
      }
      const lh = size * 1.25
      const startY = -((lines.length - 1) * lh) / 2
      lines.forEach((line, i) => {
        ctx.fillText(line, 0, startY + i * lh)
      })
    } else {
      const tileScale = 0.42
      const size = Math.max(8, w * wm.sizeRatio * tileScale)
      ctx.font = `600 ${size}px -apple-system, "Segoe UI", sans-serif`
      let maxLineW = 0
      for (const line of lines) {
        maxLineW = Math.max(maxLineW, ctx.measureText(line).width)
      }
      const lh = size * 1.25
      const textBlockH = lines.length * lh
      const rad = (-wm.angle * Math.PI) / 180
      const cos = Math.abs(Math.cos(rad))
      const sin = Math.abs(Math.sin(rad))
      const rotW = maxLineW * cos + textBlockH * sin
      const rotH = maxLineW * sin + textBlockH * cos
      const stepX = Math.max(rotW * 1.35, w / 2.5)
      const stepY = Math.max(rotH * 1.5, h / 4)
      const cols = Math.ceil(w / stepX) + 1
      const rows = Math.ceil(h / stepY) + 1

      for (let r = 0; r <= rows; r++) {
        const y = (r - 0.5) * stepY
        const xOffset = r % 2 === 1 ? stepX * 0.5 : 0
        for (let c = -1; c <= cols; c++) {
          const x = c * stepX + xOffset
          ctx.save()
          ctx.translate(x, y)
          ctx.rotate(rad)
          const startY = -((lines.length - 1) * lh) / 2
          lines.forEach((line, i) => {
            ctx.fillText(line, 0, startY + i * lh)
          })
          ctx.restore()
        }
      }
    }
    ctx.restore()
  }, [wm, tab, t])

  const field = (key: keyof HeaderFooterConfig, label: string): ReactElement => (
    <label className="pdf-field">
      <span>{label}</span>
      <input
        className="pdf-modal-input"
        value={String(hf[key])}
        onChange={(e) => setHf({ ...hf, [key]: e.target.value })}
      />
    </label>
  )

  return (
    <DraggableModal className="pdf-modal-stamp" onMaskClick={onCancel}>
      <div className="pdf-modal-title">{t('stampTitle')}</div>
      <div className="pdf-sign-tabs">
        <button
          type="button"
          className={`pdf-sign-tab${tab === 'watermark' ? ' active' : ''}`}
          onClick={() => setTab('watermark')}
        >
          {t('watermark')}
        </button>
        <button
          type="button"
          className={`pdf-sign-tab${tab === 'hf' ? ' active' : ''}`}
          onClick={() => setTab('hf')}
        >
          {t('headerFooter')}
        </button>
      </div>

      {tab === 'watermark' ? (
        <div className="pdf-wm-columns">
          <div className="pdf-wm-left-col">
            <label className="pdf-field">
              <span>{t('watermarkText')}</span>
              <textarea
                className="pdf-modal-input pdf-wm-textarea"
                rows={2}
                value={wm.text}
                placeholder={t('watermarkPlaceholder')}
                autoFocus
                onChange={(e) => setWm({ ...wm, text: e.target.value })}
              />
            </label>

            <label className="pdf-field">
              <span>{t('watermarkLayout')}</span>
              <div className="pdf-wm-layout-pills">
                <button
                  type="button"
                  className={`pdf-wm-layout-pill${wm.layout !== 'tile' ? ' active' : ''}`}
                  onClick={() => setWm({ ...wm, layout: 'center' })}
                >
                  {t('watermarkCenter')}
                </button>
                <button
                  type="button"
                  className={`pdf-wm-layout-pill${wm.layout === 'tile' ? ' active' : ''}`}
                  onClick={() => setWm({ ...wm, layout: 'tile' })}
                >
                  {t('watermarkTile')}
                </button>
              </div>
            </label>

            <label className="pdf-field">
              <span>{t('watermarkAngle')}</span>
              <input
                type="range"
                min={-90}
                max={90}
                value={wm.angle}
                onChange={(e) => setWm({ ...wm, angle: Number(e.target.value) })}
              />
              <em>{wm.angle}°</em>
            </label>

            <label className="pdf-field">
              <span>{t('watermarkOpacity')}</span>
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round(wm.opacity * 100)}
                onChange={(e) => setWm({ ...wm, opacity: Number(e.target.value) / 100 })}
              />
              <em>{Math.round(wm.opacity * 100)}%</em>
            </label>

            <label className="pdf-field">
              <span>{t('watermarkSize')}</span>
              <input
                type="range"
                min={4}
                max={22}
                value={Math.round(wm.sizeRatio * 100)}
                onChange={(e) => setWm({ ...wm, sizeRatio: Number(e.target.value) / 100 })}
              />
              <em>{Math.round(wm.sizeRatio * 100)}%</em>
            </label>

            <label className="pdf-field">
              <span>{t('drawColor')}</span>
              <span className="pdf-color-row">
                {WM_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`pdf-color-dot${wm.color === c ? ' active' : ''}`}
                    style={{ background: c }}
                    onClick={() => setWm({ ...wm, color: c })}
                  />
                ))}
              </span>
            </label>
          </div>

          <div className="pdf-wm-preview-col">
            <div className="pdf-wm-preview-label">{t('preview')}</div>
            <div className="pdf-wm-preview-sheet">
              <canvas ref={previewCanvasRef} className="pdf-wm-canvas" />
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="pdf-field-grid">
            {field('headerLeft', t('hfHeaderLeft'))}
            {field('headerCenter', t('hfHeaderCenter'))}
            {field('headerRight', t('hfHeaderRight'))}
            {field('footerLeft', t('hfFooterLeft'))}
            {field('footerCenter', t('hfFooterCenter'))}
            {field('footerRight', t('hfFooterRight'))}
          </div>
          <label className="pdf-field">
            <input
              type="checkbox"
              checked={hf.pageNumber}
              onChange={(e) => setHf({ ...hf, pageNumber: e.target.checked })}
            />
            <span>{t('hfPageNumber')}</span>
          </label>
          {hf.pageNumber && (
            <label className="pdf-field">
              <span>{t('hfStartAt')}</span>
              <input
                className="pdf-modal-input pdf-input-sm"
                type="number"
                min={1}
                value={hf.startAt}
                onChange={(e) =>
                  setHf({ ...hf, startAt: Math.max(1, Number(e.target.value) || 1) })
                }
              />
            </label>
          )}
          <div className="pdf-sign-hint">{t('hfTokenHint')}</div>
        </>
      )}

      <div className="pdf-modal-actions">
        <button type="button" className="pdf-modal-btn" onClick={onCancel}>
          {t('cancel')}
        </button>
        <button
          type="button"
          className="pdf-modal-btn primary"
          disabled={!canApply}
          onClick={() => onApply(wm.text.trim() ? wm : null, hfUsed ? hf : null)}
        >
          {t('ok')}
        </button>
      </div>
    </DraggableModal>
  )
}
