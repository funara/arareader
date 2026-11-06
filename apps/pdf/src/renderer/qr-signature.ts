import qrcode from 'qrcode-generator'
import iconUrl from '../../../../public/ARAReader-icon.png?url'
import type { SignatureData } from './SignatureDialog'
import type { SavedSignatureItem } from '../shared/ipc'
import { cssRgb } from './DrawLayer'

// QR byte mode must encode names and signing details as UTF-8, not Latin-1.
qrcode.stringToBytes = (text) => Array.from(new TextEncoder().encode(text))

export function qrSignatureDetails(name: string, intent: string, recipient: string, now: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const offset = -now.getTimezoneOffset()
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  const timestamp = `${date}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${zone}`
  return {
    date,
    payload: `Signed by: ${name}\nDate: ${timestamp}\nIntent: ${intent}\nRecipient: ${recipient}\n\nSigned using ARAReader by ARAOffice`,
  }
}

export interface QrSignatureLayout {
  signatureX: number
  signatureY: number
  qrX: number
  qrY: number
  signatureScale?: number
}

export function signaturePreviewSize(primary: SavedSignatureItem, multiplier = 1) {
  const scale = Math.min(1.3 / primary.width, 0.8 / primary.height) * multiplier
  return { width: primary.width * scale, height: primary.height * scale }
}

export function defaultQrSignatureLayout(primary: SavedSignatureItem): QrSignatureLayout {
  return {
    signatureX: 0,
    signatureY: 0,
    qrX: Math.min(1.3, (0.8 * primary.width) / primary.height) + 0.02,
    qrY: 0.5,
  }
}

export async function createQrSignature(
  name: string,
  intent: string,
  recipient: string,
  now: Date,
  primary?: SavedSignatureItem,
  layout?: QrSignatureLayout,
): Promise<SignatureData> {
  const { date, payload } = qrSignatureDetails(name, intent, recipient, now)
  const qr = qrcode(0, 'H')
  qr.addData(payload, 'Byte')
  qr.make()
  const modules = qr.getModuleCount()
  const cell = 6
  const margin = 4 * cell
  const size = (modules + 8) * cell
  if (primary && (!primary.width || !primary.height)) throw new Error('Invalid primary signature')
  const positions = primary ? (layout ?? defaultQrSignatureLayout(primary)) : null
  const scale = primary
    ? (size * signaturePreviewSize(primary, positions?.signatureScale).width) / primary.width
    : 0
  const signatureX = positions ? Math.round(positions.signatureX * size) : 0
  const signatureY = positions ? Math.round(positions.signatureY * size) : 0
  const qrX = positions ? Math.round(positions.qrX * size) : 0
  const qrY = positions ? Math.round(positions.qrY * size) : 0
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  const startFontSize = Math.floor((size * 0.4) / 2 / 1.25)
  ctx.font = `${startFontSize}px sans-serif`
  const textWidth = Math.ceil(Math.max(size - margin * 2, ctx.measureText(`Date: ${date}`).width))
  canvas.width = Math.ceil(
    Math.max(qrX + size + textWidth + margin * 2, primary ? signatureX + primary.width * scale : 0),
  )
  canvas.height = Math.ceil(Math.max(qrY + size, primary ? signatureY + primary.height * scale : 0))
  if (primary) {
    if (primary.kind === 'strokes' && primary.paths?.length) {
      ctx.strokeStyle = cssRgb(primary.color ?? [0, 0, 0])
      ctx.lineWidth = 2.4 * scale
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const path of primary.paths) {
        if (path.length < 4) continue
        ctx.beginPath()
        ctx.moveTo(signatureX + path[0]! * scale, signatureY + path[1]! * scale)
        for (let i = 2; i + 1 < path.length; i += 2)
          ctx.lineTo(signatureX + path[i]! * scale, signatureY + path[i + 1]! * scale)
        ctx.stroke()
      }
    } else if (primary.kind === 'image' && primary.image) {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('Could not load primary signature'))
        image.src = `data:image/png;base64,${primary.image}`
      })
      ctx.drawImage(image, signatureX, signatureY, primary.width * scale, primary.height * scale)
    } else {
      throw new Error('Invalid primary signature')
    }
    // Keep signature ink out of the QR and its quiet zone without adding an opaque background.
    ctx.clearRect(qrX, qrY, size + textWidth + margin * 2, size)
  }
  ctx.fillStyle = '#000'
  ctx.beginPath()
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col))
        ctx.roundRect(qrX + margin + col * cell, qrY + margin + row * cell, cell, cell, cell * 0.2)
    }
  }
  ctx.fill()
  const icon = new Image()
  await new Promise<void>((resolve, reject) => {
    icon.onload = () => resolve()
    icon.onerror = () => reject(new Error('Could not load ARAReader icon'))
    icon.src = iconUrl
  })
  const iconSize = Math.round(size * 0.14)
  const iconPadding = Math.max(2, Math.round(size * 0.01))
  const iconX = qrX + (size - iconSize) / 2
  const iconY = qrY + (size - iconSize) / 2
  ctx.save()
  ctx.beginPath()
  ctx.arc(qrX + size / 2, qrY + size / 2, iconSize / 2 + iconPadding, 0, 2 * Math.PI)
  ctx.fillStyle = '#fff'
  ctx.fill()
  ctx.clip()
  ctx.drawImage(icon, iconX, iconY, iconSize, iconSize)
  ctx.restore()
  ctx.fillStyle = '#000'
  let fontSize = startFontSize
  let lines: string[]
  let lineHeight = 0
  do {
    ctx.font = `${fontSize}px sans-serif`
    lines = ['']
    for (const char of `Name: ${name}`) {
      const current = lines.length - 1
      const text = lines[current]! + char
      if (ctx.measureText(text).width > textWidth && lines[current]) {
        const space = text.lastIndexOf(' ')
        if (space > 0) {
          lines[current] = text.slice(0, space)
          lines.push(text.slice(space + 1))
        } else lines.push(char)
      } else lines[current] = text
    }
    const dateLine = `Date: ${date}`
    lines.push(dateLine)
    lineHeight = fontSize * 1.25
    if (
      (lines.length * lineHeight <= size * 0.4 && ctx.measureText(dateLine).width <= textWidth) ||
      fontSize <= 1
    )
      break
    fontSize--
  } while (fontSize > 0)
  ctx.textBaseline = 'middle'
  const top = qrY + size - margin - (lines.length - 0.5) * lineHeight
  lines.forEach((line, i) => ctx.fillText(line, qrX + size + margin, top + i * lineHeight))
  const image = canvas.toDataURL('image/png').split(',')[1]
  if (!image) throw new Error('Could not create QR signature')
  return {
    kind: 'image',
    image,
    width: canvas.width,
    height: canvas.height,
    qr: true,
    qrWithSignature: !!primary,
  }
}
