import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jsQR from 'jsqr'
import { createCanvas } from '@napi-rs/canvas'
import { createQrSignature, qrSignatureDetails } from '../src/renderer/qr-signature'
import { fitPreview } from '../src/renderer/SignatureDialog'

beforeEach(() => {
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null
      set src(_value: string) {
        this.onload?.()
      }
    },
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('QR Digital signatures', () => {
  it('keeps an enlarged signature and allows overlap when wider QR details reach the stage edge', () => {
    const original = { signatureX: 0.1, signatureY: 1, signatureScale: 2.5, qrX: 1.92, qrY: 1 }
    const fitted = fitPreview(original, 2.3)
    expect(fitted).toEqual({ ...original, qrX: 4 - 2.3 })
    expect(fitted.qrX + 2.3).toBeLessThanOrEqual(4)
  })

  it('uses the same local date for the visible label and the timezone-aware payload', () => {
    const now = new Date('2026-11-06T17:30:45Z')
    vi.spyOn(now, 'getFullYear').mockReturnValue(2026)
    vi.spyOn(now, 'getMonth').mockReturnValue(10)
    vi.spyOn(now, 'getDate').mockReturnValue(7)
    vi.spyOn(now, 'getHours').mockReturnValue(1)
    vi.spyOn(now, 'getMinutes').mockReturnValue(30)
    vi.spyOn(now, 'getSeconds').mockReturnValue(45)
    vi.spyOn(now, 'getTimezoneOffset').mockReturnValue(-480)
    expect(qrSignatureDetails('Adhi', 'Approval', 'ARA', now)).toEqual({
      date: '2026-11-07',
      payload:
        'Signed by: Adhi\nDate: 2026-11-07T01:30:45+08:00\nIntent: Approval\nRecipient: ARA\n\nSigned using ARAReader by ARAOffice',
    })
    vi.spyOn(now, 'getTimezoneOffset').mockReturnValue(210)
    expect(qrSignatureDetails('Adhi', 'Approval', 'ARA', now).payload).toContain('-03:30')
  })

  it('generates a transparent decodable QR with a circular icon backing and compact outside labels', async () => {
    let pixels: Uint8ClampedArray
    const labels: string[] = []
    const ctx = {
      canvas: document.createElement('canvas'),
      fillStyle: '',
      font: '',
      textBaseline: '',
      measureText: (text: string) => ({ width: text.length * 10 }),
      fillRect(x: number, y: number, w: number, h: number) {
        if (!pixels) pixels = new Uint8ClampedArray(ctx.canvas.width * ctx.canvas.height * 4)
        const color = this.fillStyle === '#fff' ? 255 : 0
        for (let row = Math.floor(y); row < Math.floor(y + h); row++)
          for (let col = Math.floor(x); col < Math.floor(x + w); col++) {
            const i = (row * ctx.canvas.width + col) * 4
            pixels[i] = pixels[i + 1] = pixels[i + 2] = color
            pixels[i + 3] = 255
          }
      },
      beginPath: vi.fn(),
      roundRect(x: number, y: number, w: number, h: number) {
        this.fillRect(x, y, w, h)
      },
      fill: vi.fn(),
      arc: vi.fn(),
      clip: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      drawImage: vi.fn(),
      fillText(text: string) {
        labels.push(text)
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      ctx.canvas = this
      return ctx as unknown as CanvasRenderingContext2D
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,TEST')
    const now = new Date('2026-11-06T12:34:56Z')
    const signature = await createQrSignature('李 明', 'Approved ✓', 'ARA', now)
    expect(signature.kind).toBe('image')
    expect(pixels![3]).toBe(0)
    expect(Number.parseInt(ctx.font, 10)).toBe(Math.floor((ctx.canvas.height * 0.4) / 2 / 1.25))
    expect(ctx.arc).toHaveBeenCalledWith(
      ctx.canvas.height / 2,
      ctx.canvas.height / 2,
      expect.any(Number),
      0,
      2 * Math.PI,
    )
    expect(ctx.clip).toHaveBeenCalledOnce()
    expect(labels).toEqual([
      'Name: 李 明',
      `Date: ${qrSignatureDetails('李 明', 'Approved ✓', 'ARA', now).date}`,
    ])
    const onWhite = pixels!.slice()
    for (let i = 0; i < onWhite.length; i += 4) {
      if (onWhite[i + 3] === 0) onWhite[i] = onWhite[i + 1] = onWhite[i + 2] = 255
      onWhite[i + 3] = 255
    }
    expect(jsQR(onWhite, ctx.canvas.width, ctx.canvas.height)?.data).toBe(
      qrSignatureDetails('李 明', 'Approved ✓', 'ARA', now).payload,
    )
  })

  it('places the QR beyond the primary signature and fits labels within two fifths of its height', async () => {
    const measured = createCanvas(1, 1).getContext('2d')
    const rectangles: number[] = []
    const labels: string[] = []
    const labelY: number[] = []
    const ctx = {
      canvas: document.createElement('canvas'),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      lineCap: '',
      lineJoin: '',
      font: '',
      textBaseline: '',
      measureText(text: string) {
        measured.font = this.font
        return measured.measureText(text)
      },
      fillRect: vi.fn(),
      roundRect(x: number) {
        rectangles.push(x)
      },
      fill: vi.fn(),
      arc: vi.fn(),
      clip: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      drawImage: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText(text: string, _x: number, y: number) {
        labels.push(text)
        labelY.push(y)
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      ctx.canvas = this
      return ctx as unknown as CanvasRenderingContext2D
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,TEST')
    const primary = {
      id: 'primary',
      label: 'Primary',
      kind: 'strokes' as const,
      paths: [[0, 0, 420, 150]],
      width: 420,
      height: 150,
      createdAt: 1,
    }
    const result = await createQrSignature(
      'Adhi',
      'Approval',
      'ARA',
      new Date('2026-11-06T12:00:00Z'),
      primary,
    )
    expect(result.kind).toBe('image')
    const size = ctx.canvas.height / 1.5
    const primaryWidth = Math.ceil(
      primary.width * Math.min((size * 1.3) / primary.width, (size * 0.8) / primary.height),
    )
    expect(Math.min(...rectangles)).toBeGreaterThanOrEqual(primaryWidth)
    expect(Number.parseInt(ctx.font, 10)).toBeGreaterThan(size / 8)
    expect(labels).toHaveLength(2)
    expect(labels[0]).toBe('Name: Adhi')
    expect(labels[1]).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/)
    expect(labelY[1]).toBeCloseTo(
      ctx.canvas.height - 24 - (Number.parseInt(ctx.font, 10) * 1.25) / 2,
    )
    expect(measured.measureText(labels[1]!).width).toBeLessThanOrEqual(
      ctx.canvas.width - primaryWidth - size - 24,
    )
    expect(labels.length * Number.parseInt(ctx.font, 10) * 1.25).toBeLessThanOrEqual(size * 0.4)

    labels.length = 0
    await createQrSignature(
      'Very long name '.repeat(8),
      'Approval',
      'ARA',
      new Date('2026-11-06T12:00:00Z'),
      primary,
    )
    const longSize = ctx.canvas.height / 1.5
    expect(labels.length).toBeGreaterThan(2)
    expect(labels.length * Number.parseInt(ctx.font, 10) * 1.25).toBeLessThanOrEqual(longSize * 0.4)

    rectangles.length = 0
    ctx.moveTo.mockClear()
    await createQrSignature('Adhi', 'Approval', 'ARA', new Date('2026-11-06T12:00:00Z'), primary, {
      signatureX: 0.3,
      signatureY: 0.2,
      qrX: 2,
      qrY: 1,
      signatureScale: 1.5,
    })
    const adjustedSize = ctx.canvas.height / 2
    expect(ctx.moveTo).toHaveBeenCalledWith(
      Math.round(adjustedSize * 0.3),
      Math.round(adjustedSize * 0.2),
    )
    const [endX, endY] = ctx.lineTo.mock.lastCall!
    expect(endX).toBeCloseTo(Math.round(adjustedSize * 0.3) + adjustedSize * 1.3 * 1.5)
    expect(endY).toBeCloseTo(
      Math.round(adjustedSize * 0.2) + (adjustedSize * 1.3 * 1.5 * 150) / 420,
    )
    expect(Math.min(...rectangles)).toBe(Math.round(adjustedSize * 2) + 24)
  })
})
