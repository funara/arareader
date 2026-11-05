import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { AiProviderId, AiSettings } from '@arareader/ai-provider'
import {
  CUSTOM_ENDPOINT_PRESETS,
  DEFAULT_CUSTOM_MODEL,
  DEFAULT_GOOGLE_MODEL,
  GOOGLE_MODELS,
} from '@arareader/ai-provider'
import type { ReaderPreferences, SavedSignature, UiTheme, UserProfile } from '../../shared/home-api'

/** Where a Gemini key comes from. */
const AI_STUDIO_URL = 'https://aistudio.google.com/apikey'

const SIGN_PAD_W = 400
const SIGN_PAD_H = 128
const MAX_SIGN_IMG = 1200
const TYPE_FONT_PX = 180

const SIGN_FONTS: { id: string; label: string; family: string; italic?: boolean }[] = [
  {
    id: 'script',
    label: 'Signature Script',
    family: `"Snell Roundhand", "Segoe Script", "Brush Script MT", cursive`,
    italic: true,
  },
  {
    id: 'serif-italic',
    label: 'Editorial Serif',
    family: `"Georgia", "Times New Roman", serif`,
    italic: true,
  },
  {
    id: 'kaiti',
    label: 'Calligraphic',
    family: `"Kaiti SC", "STKaiti", "KaiTi", "Palatino Linotype", serif`,
  },
  {
    id: 'classic',
    label: 'Formal Roman',
    family: `"Songti SC", "SimSun", "Times New Roman", serif`,
  },
]

const SIGN_COLORS: { id: string; label: string; rgb: [number, number, number]; hex: string }[] = [
  { id: 'black', label: 'Ink Black', rgb: [0.08, 0.09, 0.12], hex: '#14171f' },
  { id: 'cobalt', label: 'Cobalt Blue', rgb: [0.11, 0.36, 0.84], hex: '#1d5bd6' },
  { id: 'crimson', label: 'Crimson Ink', rgb: [0.73, 0.11, 0.11], hex: '#b91c1c' },
]

export type SettingsSection = 'ai' | 'profile' | 'esign' | 'general'

/** Local servers (Ollama, LM Studio) normally run without a key. */
function isLocalhostEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl.trim())
}

/** OpenAI-compatible roots are http(s) URLs with no trailing slash. */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rgbCss(rgb: [number, number, number]): string {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`
}

async function fileToCanvas(file: File): Promise<HTMLCanvasElement | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('decode'))
      img.src = url
    })
    const scale = Math.min(1, MAX_SIGN_IMG / Math.max(img.naturalWidth, img.naturalHeight, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

function toCleanStamp(src: HTMLCanvasElement, rgb: [number, number, number]): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height
  const ctx = out.getContext('2d', { willReadFrequently: true })
  const srcCtx = src.getContext('2d', { willReadFrequently: true })
  if (!ctx || !srcCtx) return src
  const img = srcCtx.getImageData(0, 0, src.width, src.height)
  const d = img.data
  const rTarget = Math.round(rgb[0] * 255)
  const gTarget = Math.round(rgb[1] * 255)
  const bTarget = Math.round(rgb[2] * 255)
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!
    const a = lum > 205 ? 0 : lum < 125 ? 255 : Math.round(((205 - lum) / 80) * 255)
    d[i] = rTarget
    d[i + 1] = gTarget
    d[i + 2] = bTarget
    d[i + 3] = Math.round((a * d[i + 3]!) / 255)
  }
  ctx.putImageData(img, 0, 0)
  return out
}

function rasterizeTypedSignature(
  text: string,
  fontSpec: (typeof SIGN_FONTS)[number],
  color: [number, number, number],
): { image: string; width: number; height: number } | null {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const font = `${fontSpec.italic ? 'italic ' : ''}${TYPE_FONT_PX}px ${fontSpec.family}`
  ctx.font = font
  const m = ctx.measureText(text)
  const pad = Math.ceil(TYPE_FONT_PX * 0.1)
  const left = Math.ceil(m.actualBoundingBoxLeft || 8) + pad
  const ascent = Math.ceil(m.actualBoundingBoxAscent || TYPE_FONT_PX * 0.75) + pad
  const right = Math.ceil(m.actualBoundingBoxRight || m.width) + pad
  const descent = Math.ceil(m.actualBoundingBoxDescent || TYPE_FONT_PX * 0.25) + pad
  canvas.width = Math.max(2, left + right)
  canvas.height = Math.max(2, ascent + descent)
  ctx.font = font
  ctx.fillStyle = rgbCss(color)
  ctx.fillText(text, left, ascent)
  const base64 = canvas.toDataURL('image/png').split(',')[1]
  return base64 ? { image: base64, width: canvas.width, height: canvas.height } : null
}

/** Preview thumbnail for a saved stroke or image signature */
export function SavedSignaturePreview({ sig }: { sig: SavedSignature }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (sig.kind !== 'strokes' || !sig.paths) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const sx = canvas.width / Math.max(1, sig.width)
    const sy = canvas.height / Math.max(1, sig.height)
    const scale = Math.min(sx, sy)
    const ox = (canvas.width - sig.width * scale) / 2
    const oy = (canvas.height - sig.height * scale) / 2
    ctx.strokeStyle = rgbCss(sig.color ?? [0.08, 0.09, 0.12])
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const p of sig.paths) {
      if (p.length < 4) continue
      ctx.beginPath()
      ctx.moveTo(ox + p[0]! * scale, oy + p[1]! * scale)
      for (let i = 2; i < p.length; i += 2) {
        ctx.lineTo(ox + p[i]! * scale, oy + p[i + 1]! * scale)
      }
      ctx.stroke()
    }
  }, [sig])

  if (sig.kind === 'image' && sig.image) {
    return (
      <img
        className="esign-card-preview-img"
        src={`data:image/png;base64,${sig.image}`}
        alt={sig.label}
      />
    )
  }
  return <canvas ref={canvasRef} className="esign-card-preview-canvas" width={180} height={58} />
}

function CloseIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

const DEFAULT_PREFS: ReaderPreferences = {
  profile: {
    displayName: '',
    fullName: '',
    title: '',
    organization: '',
    email: '',
    useAsDefaultAuthor: true,
  },
  signatures: [],
  starredPaths: [],
  defaultZoom: 'fit-width',
  defaultSidebar: 'none',
  autosave: false,
  aiAutoSuggestions: true,
  onboardingCompleted: false,
}

export interface ProviderModalProps {
  onClose: () => void
  /** called after a successful save so the caller can refresh its status */
  onSaved?: () => void
  /** optional initial tab when opened from a specific affordance */
  initialSection?: SettingsSection
}

/**
 * Unified Settings Dialog:
 * - Profile (display name for Home greeting, signer identity, default PDF author)
 * - AI Copilot (Gemini / OpenAI-compatible provider setup)
 * - E-Sign (create & manage reusable signatures/initials shared with the PDF Sign tool)
 * - Preferences (appearance theme, reader defaults, updates)
 */
export function ProviderModal({
  onClose,
  onSaved,
  initialSection = 'profile',
}: ProviderModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)

  // AI Provider state
  const [choice, setChoice] = useState<AiProviderId>('google')
  const [googleModel, setGoogleModel] = useState<string>(DEFAULT_GOOGLE_MODEL)
  const [googleKey, setGoogleKey] = useState('')
  const [hasSavedGoogleKey, setHasSavedGoogleKey] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasSavedKey, setHasSavedKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [savedNotice, setSavedNotice] = useState('')
  const currentRef = useRef<AiSettings | null>(null)
  const apiKeyInputRef = useRef<HTMLInputElement>(null)
  const modelComboRef = useRef<HTMLDivElement>(null)

  // User Preferences (Profile, E-Sign, Reader Defaults)
  const [prefs, setPrefs] = useState<ReaderPreferences>(DEFAULT_PREFS)
  const [themePref, setThemePref] = useState<UiTheme>('system')

  // E-Sign Creator state
  const [creatingSig, setCreatingSig] = useState(false)
  const [sigLabel, setSigLabel] = useState('Primary Signature')
  const [sigMode, setSigMode] = useState<'draw' | 'type' | 'image'>('draw')
  const [sigColorIdx, setSigColorIdx] = useState(0)
  const [sigTyped, setSigTyped] = useState('')
  const [sigFontIdx, setSigFontIdx] = useState(0)
  const [sigImgCanvas, setSigImgCanvas] = useState<HTMLCanvasElement | null>(null)
  const [sigBw, setSigBw] = useState(true)
  const sigFileRef = useRef<HTMLInputElement>(null)
  const sigPadRef = useRef<HTMLCanvasElement>(null)
  const sigPathsRef = useRef<number[][]>([])
  const sigCurPathRef = useRef<number[] | null>(null)
  const [sigHasStrokes, setSigHasStrokes] = useState(false)

  const activeColor = SIGN_COLORS[sigColorIdx] ?? SIGN_COLORS[0]!

  useEffect(() => {
    let canceled = false
    void Promise.all([
      window.readerAi.getSettings().catch(() => null),
      window.reader.getPreferences?.().catch(() => null) ?? Promise.resolve(null),
      window.reader.getTheme?.().catch(() => 'system' as UiTheme) ??
        Promise.resolve('system' as UiTheme),
    ])
      .then(([aiSettings, userPrefs, currentTheme]) => {
        if (canceled) return
        if (aiSettings) {
          currentRef.current = aiSettings
          setChoice(aiSettings.provider === 'custom' ? 'custom' : 'google')
          setGoogleModel(aiSettings.providers.google.model || DEFAULT_GOOGLE_MODEL)
          setHasSavedGoogleKey(Boolean(aiSettings.providers.google.hasApiKey))
          const storedBase = aiSettings.providers.custom.baseUrl ?? ''
          const storedHasKey = Boolean(aiSettings.providers.custom.hasApiKey)
          setEndpoint(storedBase)
          setModel(aiSettings.providers.custom.model ?? '')
          setHasSavedKey(storedHasKey)
          // Silently populate the model dropdown if a custom endpoint is already configured
          const cleanBase = normalizeBaseUrl(storedBase)
          if (isHttpUrl(cleanBase) && (storedHasKey || isLocalhostEndpoint(cleanBase))) {
            void window.readerAi
              .fetchCustomModels({ baseUrl: cleanBase })
              .then((res) => {
                if (!canceled && res.ok && res.models.length > 0) {
                  setModels(res.models)
                }
              })
              .catch(() => {})
          }
        }
        if (userPrefs) {
          setPrefs(userPrefs)
          if (!sigTyped && userPrefs.profile.fullName) {
            setSigTyped(userPrefs.profile.fullName)
          } else if (!sigTyped && userPrefs.profile.displayName) {
            setSigTyped(userPrefs.profile.displayName)
          }
        }
        if (currentTheme) setThemePref(currentTheme)
      })
      .finally(() => {
        if (!canceled) setLoaded(true)
      })
    return () => {
      canceled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (modelMenuOpen) {
          setModelMenuOpen(false)
          return
        }
        onClose()
      }
    }
    const onPointerDown = (event: MouseEvent) => {
      if (
        modelMenuOpen &&
        modelComboRef.current &&
        !modelComboRef.current.contains(event.target as Node)
      ) {
        setModelMenuOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [onClose, modelMenuOpen])

  const googleModels = useMemo(() => {
    const known: string[] = [...GOOGLE_MODELS]
    const stored = googleModel.trim()
    return stored && !known.includes(stored) ? [stored, ...known] : known
  }, [googleModel])

  const fetchModels = useCallback(async () => {
    const baseUrl = normalizeBaseUrl(endpoint)
    if (!isHttpUrl(baseUrl)) {
      setError('Enter a valid http(s) endpoint first.')
      return
    }
    const needsRemoteKey = !isLocalhostEndpoint(baseUrl) && !apiKey.trim() && !hasSavedKey
    setFetching(true)
    setError('')
    try {
      const result = await window.readerAi.fetchCustomModels({
        baseUrl,
        apiKey: apiKey.trim() || undefined,
      })
      if (!result.ok) {
        if (needsRemoteKey) {
          setError('Enter your API key first, then click Fetch models.')
          apiKeyInputRef.current?.focus()
          return
        }
        setError(result.error || 'Could not fetch models from this endpoint.')
        return
      }
      setModels(result.models)
      if (result.models.length === 0) {
        if (needsRemoteKey) {
          setError('No models returned. Enter your API key above first, then click Fetch models.')
          apiKeyInputRef.current?.focus()
          return
        }
        setError('The endpoint returned no models. Type the model ID manually.')
        return
      }
      const currentTrimmed = model.trim()
      if (!currentTrimmed || !result.models.includes(currentTrimmed)) {
        setModel(result.models[0]!)
      }
      setModelMenuOpen(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setFetching(false)
    }
  }, [endpoint, apiKey, hasSavedKey, model])

  // Persist user preferences helper
  const persistPrefs = useCallback(async (next: ReaderPreferences) => {
    setPrefs(next)
    if (window.reader.setPreferences) {
      const saved = await window.reader.setPreferences(next)
      setPrefs(saved)
    }
  }, [])

  // Redraw signature pad when drawing or changing ink color
  const redrawSigPad = useCallback(() => {
    const canvas = sigPadRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = activeColor.hex
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const p of sigPathsRef.current) {
      if (p.length < 4) continue
      ctx.beginPath()
      ctx.moveTo(p[0]!, p[1]!)
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!)
      ctx.stroke()
    }
  }, [activeColor.hex])

  useEffect(() => {
    if (activeSection === 'esign' && creatingSig && sigMode === 'draw') {
      redrawSigPad()
    }
  }, [activeSection, creatingSig, sigMode, redrawSigPad])

  const padPos = (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const box = e.currentTarget.getBoundingClientRect()
    const scaleX = SIGN_PAD_W / Math.max(1, box.width)
    const scaleY = SIGN_PAD_H / Math.max(1, box.height)
    return [(e.clientX - box.left) * scaleX, (e.clientY - box.top) * scaleY]
  }

  const onPadDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const pt = padPos(e)
    sigCurPathRef.current = [pt[0], pt[1]]
    sigPathsRef.current = [...sigPathsRef.current, sigCurPathRef.current]
  }

  const onPadMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!sigCurPathRef.current) return
    const [x, y] = padPos(e)
    sigCurPathRef.current.push(x, y)
    if (sigCurPathRef.current.length >= 4 && !sigHasStrokes) setSigHasStrokes(true)
    redrawSigPad()
  }

  const onPadUp = () => {
    sigCurPathRef.current = null
  }

  const clearSigPad = () => {
    sigPathsRef.current = []
    setSigHasStrokes(false)
    redrawSigPad()
  }

  const processedUpload = useMemo(() => {
    if (!sigImgCanvas) return null
    const canvas = sigBw ? toCleanStamp(sigImgCanvas, activeColor.rgb) : sigImgCanvas
    return { canvas, url: canvas.toDataURL('image/png') }
  }, [sigImgCanvas, sigBw, activeColor.rgb])

  const onPickSigImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const canvas = await fileToCanvas(file)
    if (canvas) setSigImgCanvas(canvas)
  }

  const saveNewSignature = async () => {
    const label = sigLabel.trim() || 'Signature'
    const id = `sig-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const isFirst = prefs.signatures.length === 0
    let entry: SavedSignature | null = null

    if (sigMode === 'draw') {
      const validPaths = sigPathsRef.current.filter((p) => p.length >= 4)
      if (validPaths.length === 0) return
      entry = {
        id,
        label,
        kind: 'strokes',
        paths: validPaths,
        width: SIGN_PAD_W,
        height: SIGN_PAD_H,
        color: activeColor.rgb,
        createdAt: Date.now(),
        isDefault: isFirst,
      }
    } else if (sigMode === 'type') {
      const text = sigTyped.trim()
      if (!text) return
      const raster = rasterizeTypedSignature(
        text,
        SIGN_FONTS[sigFontIdx] ?? SIGN_FONTS[0]!,
        activeColor.rgb,
      )
      if (!raster) return
      entry = {
        id,
        label,
        kind: 'image',
        image: raster.image,
        width: raster.width,
        height: raster.height,
        createdAt: Date.now(),
        isDefault: isFirst,
      }
    } else if (sigMode === 'image' && processedUpload) {
      const base64 = processedUpload.canvas.toDataURL('image/png').split(',')[1]
      if (!base64) return
      entry = {
        id,
        label,
        kind: 'image',
        image: base64,
        width: processedUpload.canvas.width,
        height: processedUpload.canvas.height,
        createdAt: Date.now(),
        isDefault: isFirst,
      }
    }

    if (!entry) return
    const next: ReaderPreferences = {
      ...prefs,
      signatures: [...prefs.signatures, entry],
    }
    await persistPrefs(next)
    clearSigPad()
    setSigImgCanvas(null)
    setCreatingSig(false)
    setSavedNotice('Signature saved to E-Sign Vault.')
    setTimeout(() => setSavedNotice(''), 2500)
  }

  const deleteSignature = async (id: string) => {
    const remaining = prefs.signatures.filter((s) => s.id !== id)
    if (remaining.length > 0 && !remaining.some((s) => s.isDefault)) {
      remaining[0] = { ...remaining[0]!, isDefault: true }
    }
    await persistPrefs({ ...prefs, signatures: remaining })
  }

  const setDefaultSignature = async (id: string) => {
    const updated = prefs.signatures.map((s) => ({ ...s, isDefault: s.id === id }))
    await persistPrefs({ ...prefs, signatures: updated })
  }

  const updateProfileField = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
    setPrefs((prev) => ({
      ...prev,
      profile: {
        ...prev.profile,
        [key]: value,
      },
    }))
  }

  const handleThemeChange = async (nextTheme: UiTheme) => {
    setThemePref(nextTheme)
    await window.reader.setTheme(nextTheme)
    if (nextTheme === 'dark') {
      document.documentElement.dataset.theme = 'dark'
    } else if (nextTheme === 'light') {
      document.documentElement.dataset.theme = 'light'
    } else {
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      document.documentElement.dataset.theme = sysDark ? 'dark' : 'light'
    }
  }

  const saveAll = useCallback(async () => {
    const baseUrl = normalizeBaseUrl(endpoint)
    if (activeSection === 'ai') {
      if (choice === 'google' && !googleModel.trim()) {
        setError('Choose a Gemini model.')
        return
      }
      if (choice === 'custom' && (!isHttpUrl(baseUrl) || !model.trim())) {
        setError('A valid endpoint and model ID are required.')
        return
      }
    }
    setSaving(true)
    setError('')
    try {
      const stored = currentRef.current ?? (await window.readerAi.getSettings())
      const canSaveCustom = isHttpUrl(baseUrl) && Boolean(model.trim())
      const nextAi: AiSettings = {
        provider: choice,
        providers: {
          google:
            choice === 'google'
              ? { model: googleModel.trim() || DEFAULT_GOOGLE_MODEL, apiKey: googleKey }
              : stored.providers.google,
          custom:
            choice === 'custom' && canSaveCustom
              ? { model: model.trim(), baseUrl, apiKey }
              : stored.providers.custom,
        },
      }
      const hasName = Boolean(prefs.profile.displayName.trim() || prefs.profile.fullName.trim())
      const nextPrefs: ReaderPreferences = {
        ...prefs,
        onboardingCompleted: hasName,
      }
      await Promise.all([
        window.readerAi.setSettings(nextAi),
        window.reader.setPreferences
          ? window.reader.setPreferences(nextPrefs)
          : Promise.resolve(nextPrefs),
      ])
      onSaved?.()
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }, [
    activeSection,
    apiKey,
    choice,
    endpoint,
    googleKey,
    googleModel,
    model,
    onClose,
    onSaved,
    prefs,
  ])

  const openStudio = () => {
    void window.readerWindow.openExternal(AI_STUDIO_URL).catch(() => {})
  }

  const keyPlaceholder = (saved: boolean, sample: string): string =>
    saved ? 'Saved (leave blank to keep)' : sample

  const googleKeyHint = hasSavedGoogleKey
    ? 'A key is saved locally. Leave blank to keep it.'
    : 'Stored locally. Only sent to Google.'

  const customKeyHint = hasSavedKey
    ? 'A key is saved locally. Leave blank to keep it.'
    : isLocalhostEndpoint(endpoint)
      ? 'Optional for local endpoints (Ollama, LM Studio).'
      : 'Stored locally. Enter your API key before fetching models.'

  const canSaveNewSig =
    sigMode === 'draw'
      ? sigHasStrokes
      : sigMode === 'type'
        ? sigTyped.trim().length > 0
        : processedUpload !== null

  return (
    <div
      className="modal-overlay ai-provider-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="ai-provider-modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-provider-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ai-provider-head">
          <h3 id="ai-provider-title" className="ai-provider-title">
            Settings
          </h3>
          <button
            type="button"
            className="ai-provider-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="settings-layout">
          {/* Left Settings Navigation Rail */}
          <nav className="settings-nav" aria-label="Settings sections">
            <button
              type="button"
              className={`settings-nav-btn${activeSection === 'profile' ? ' active' : ''}`}
              onClick={() => {
                setActiveSection('profile')
                setError('')
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span>Profile</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn${activeSection === 'ai' ? ' active' : ''}`}
              onClick={() => {
                setActiveSection('ai')
                setError('')
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                <path d="M5 3v4" />
                <path d="M19 17v4" />
                <path d="M3 5h4" />
                <path d="M17 19h4" />
              </svg>
              <span>AI Copilot</span>
            </button>
            <button
              type="button"
              className={`settings-nav-btn${activeSection === 'esign' ? ' active' : ''}`}
              onClick={() => {
                setActiveSection('esign')
                setError('')
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                <path d="m15 5 4 4" />
              </svg>
              <span>E-Sign</span>
              {prefs.signatures.length > 0 && (
                <span className="settings-nav-badge">{prefs.signatures.length}</span>
              )}
            </button>
            <button
              type="button"
              className={`settings-nav-btn${activeSection === 'general' ? ' active' : ''}`}
              onClick={() => {
                setActiveSection('general')
                setError('')
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Preferences</span>
            </button>
          </nav>

          {/* Right Settings Content Pane */}
          <div className="settings-pane">
            {activeSection === 'ai' && (
              <>
                <div className="ai-provider-switch" role="tablist" aria-label="AI provider">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={choice === 'google'}
                    className={`ai-provider-switch-btn${choice === 'google' ? ' active' : ''}`}
                    onClick={() => {
                      setChoice('google')
                      setError('')
                    }}
                  >
                    Gemini (Google AI)
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={choice === 'custom'}
                    className={`ai-provider-switch-btn${choice === 'custom' ? ' active' : ''}`}
                    onClick={() => {
                      setChoice('custom')
                      setError('')
                    }}
                  >
                    OpenAI-Compatible / Local
                  </button>
                </div>

                {choice === 'google' ? (
                  <div className="ai-provider-fields">
                    <div className="ai-provider-field">
                      <label htmlFor="ai-provider-google-model" className="ai-provider-label">
                        Model
                      </label>
                      <select
                        id="ai-provider-google-model"
                        value={googleModel}
                        disabled={!loaded}
                        onChange={(event) => setGoogleModel(event.target.value)}
                      >
                        {googleModels.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="ai-provider-field">
                      <div className="ai-provider-label-row">
                        <label htmlFor="ai-provider-google-key" className="ai-provider-label">
                          API key
                        </label>
                        <button type="button" className="ai-provider-link" onClick={openStudio}>
                          Get a key ↗
                        </button>
                      </div>
                      <div className="ai-provider-input-wrap">
                        <input
                          id="ai-provider-google-key"
                          type={showKey ? 'text' : 'password'}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={!loaded}
                          value={googleKey}
                          placeholder={keyPlaceholder(hasSavedGoogleKey, 'AIza…')}
                          onChange={(event) => setGoogleKey(event.target.value)}
                        />
                        <button
                          type="button"
                          className="ai-provider-eye"
                          onClick={() => setShowKey((prev) => !prev)}
                          tabIndex={-1}
                          aria-label={showKey ? 'Hide key' : 'Show key'}
                          title={showKey ? 'Hide key' : 'Show key'}
                        >
                          <EyeIcon off={showKey} />
                        </button>
                      </div>
                      <p className="ai-provider-hint">{googleKeyHint}</p>
                    </div>
                  </div>
                ) : (
                  <div className="ai-provider-fields">
                    <div className="ai-provider-field">
                      <label htmlFor="ai-provider-endpoint" className="ai-provider-label">
                        Endpoint
                      </label>
                      <input
                        id="ai-provider-endpoint"
                        value={endpoint}
                        disabled={!loaded}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://api.openai.com/v1"
                        onChange={(event) => {
                          setEndpoint(event.target.value)
                          setModels([])
                        }}
                      />
                      <div className="ai-provider-presets">
                        {CUSTOM_ENDPOINT_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            className="ai-provider-preset"
                            onClick={() => {
                              setEndpoint(preset.baseUrl)
                              setModels([])
                            }}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="ai-provider-field">
                      <div className="ai-provider-label-row">
                        <label htmlFor="ai-provider-key" className="ai-provider-label">
                          API key
                          {isLocalhostEndpoint(endpoint) && (
                            <span className="ai-provider-optional">optional</span>
                          )}
                        </label>
                        {hasSavedKey && <span className="ai-provider-saved">Saved</span>}
                      </div>
                      <div className="ai-provider-input-wrap">
                        <input
                          ref={apiKeyInputRef}
                          id="ai-provider-key"
                          type={showKey ? 'text' : 'password'}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={!loaded}
                          value={apiKey}
                          placeholder={keyPlaceholder(hasSavedKey, 'sk-…')}
                          onChange={(event) => setApiKey(event.target.value)}
                        />
                        <button
                          type="button"
                          className="ai-provider-eye"
                          onClick={() => setShowKey((prev) => !prev)}
                          tabIndex={-1}
                          aria-label={showKey ? 'Hide key' : 'Show key'}
                          title={showKey ? 'Hide key' : 'Show key'}
                        >
                          <EyeIcon off={showKey} />
                        </button>
                      </div>
                      <p className="ai-provider-hint">{customKeyHint}</p>
                    </div>

                    <div className="ai-provider-field">
                      <div className="ai-provider-label-row">
                        <label htmlFor="ai-provider-model" className="ai-provider-label">
                          Model
                          {models.length > 0 && (
                            <span className="ai-model-count-badge">{models.length} available</span>
                          )}
                        </label>
                        <button
                          type="button"
                          className="ai-provider-link"
                          onClick={() => void fetchModels()}
                          disabled={fetching || !endpoint.trim()}
                        >
                          {fetching ? 'Fetching…' : 'Fetch models'}
                        </button>
                      </div>
                      <div className="ai-model-combobox" ref={modelComboRef}>
                        <input
                          id="ai-provider-model"
                          value={model}
                          disabled={!loaded}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={DEFAULT_CUSTOM_MODEL}
                          onFocus={() => {
                            if (models.length > 0) setModelMenuOpen(true)
                          }}
                          onChange={(event) => setModel(event.target.value)}
                        />
                        <button
                          type="button"
                          className={`ai-model-dropdown-btn${modelMenuOpen ? ' open' : ''}`}
                          aria-label="Toggle model list"
                          title={
                            models.length > 0
                              ? `Choose from ${models.length} fetched models`
                              : 'Fetch and show models'
                          }
                          disabled={!loaded || fetching}
                          onClick={() => {
                            if (models.length > 0) {
                              setModelMenuOpen((prev) => !prev)
                            } else {
                              void fetchModels()
                            }
                          }}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

                        {modelMenuOpen && models.length > 0 && (
                          <ul
                            className="ai-model-dropdown-menu"
                            role="listbox"
                            aria-label="Available models"
                          >
                            {models.map((item) => {
                              const selected = item === model.trim()
                              return (
                                <li key={item} role="option" aria-selected={selected}>
                                  <button
                                    type="button"
                                    className={`ai-model-dropdown-option${selected ? ' selected' : ''}`}
                                    onClick={() => {
                                      setModel(item)
                                      setModelMenuOpen(false)
                                    }}
                                  >
                                    <span className="ai-model-dropdown-id">{item}</span>
                                    {selected && (
                                      <span className="ai-model-dropdown-check" aria-hidden="true">
                                        ✓
                                      </span>
                                    )}
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </div>
                      <p className="ai-provider-hint">
                        {models.length > 0
                          ? 'Click the dropdown to pick a fetched model, or type any model ID.'
                          : 'Click Fetch models to load available models, or type a model ID.'}
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}

            {activeSection === 'profile' && (
              <div className="settings-section-body">
                <div className="settings-section-intro">
                  <h4>Profile</h4>
                  <p>Your name and details for greetings, notes, and signatures.</p>
                </div>

                <div className="settings-grid-2">
                  <div className="ai-provider-field">
                    <label htmlFor="profile-display-name" className="ai-provider-label">
                      Display Name
                    </label>
                    <input
                      id="profile-display-name"
                      type="text"
                      value={prefs.profile.displayName}
                      placeholder="e.g. Jhon"
                      onChange={(e) => updateProfileField('displayName', e.target.value)}
                    />
                    <p className="ai-provider-hint">Shown in your Home greeting.</p>
                  </div>

                  <div className="ai-provider-field">
                    <label htmlFor="profile-full-name" className="ai-provider-label">
                      Full Name
                    </label>
                    <input
                      id="profile-full-name"
                      type="text"
                      value={prefs.profile.fullName}
                      placeholder="e.g. Jhon Doe"
                      onChange={(e) => updateProfileField('fullName', e.target.value)}
                    />
                    <p className="ai-provider-hint">Used on signatures and PDF metadata.</p>
                  </div>
                </div>

                <div className="settings-grid-2">
                  <div className="ai-provider-field">
                    <label htmlFor="profile-title" className="ai-provider-label">
                      Role / Title <span className="ai-provider-optional">optional</span>
                    </label>
                    <input
                      id="profile-title"
                      type="text"
                      value={prefs.profile.title}
                      placeholder="e.g. Data Scientist"
                      onChange={(e) => updateProfileField('title', e.target.value)}
                    />
                  </div>

                  <div className="ai-provider-field">
                    <label htmlFor="profile-org" className="ai-provider-label">
                      Organization <span className="ai-provider-optional">optional</span>
                    </label>
                    <input
                      id="profile-org"
                      type="text"
                      value={prefs.profile.organization}
                      placeholder="e.g. ARA Ecosystem"
                      onChange={(e) => updateProfileField('organization', e.target.value)}
                    />
                  </div>
                </div>

                <div className="ai-provider-field">
                  <label htmlFor="profile-email" className="ai-provider-label">
                    Email <span className="ai-provider-optional">optional</span>
                  </label>
                  <input
                    id="profile-email"
                    type="email"
                    value={prefs.profile.email}
                    placeholder="jhon.doe@gmail.com"
                    onChange={(e) => updateProfileField('email', e.target.value)}
                  />
                </div>

                <label className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Use as default PDF author</div>
                    <div className="settings-toggle-desc">
                      Pre-fill your name as author when saving PDFs.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={prefs.profile.useAsDefaultAuthor}
                    onChange={(e) => updateProfileField('useAsDefaultAuthor', e.target.checked)}
                  />
                </label>
              </div>
            )}

            {activeSection === 'esign' && (
              <div className="settings-section-body">
                <div className="settings-section-header-row">
                  <div>
                    <h4>E-Sign</h4>
                    <p>Save your signatures in any PDF.</p>
                  </div>
                  {!creatingSig && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        setSigLabel(
                          prefs.signatures.length === 0 ? 'Primary Signature' : 'Initials',
                        )
                        setCreatingSig(true)
                      }}
                    >
                      + Add Signature
                    </button>
                  )}
                </div>

                {savedNotice && <div className="settings-inline-notice">{savedNotice}</div>}

                {creatingSig ? (
                  <div className="esign-creator-card">
                    <div className="esign-creator-top">
                      <div className="ai-provider-field" style={{ flex: 1 }}>
                        <label htmlFor="esign-label-input" className="ai-provider-label">
                          Signature Label
                        </label>
                        <input
                          id="esign-label-input"
                          type="text"
                          value={sigLabel}
                          placeholder="e.g. Primary Signature, Initials"
                          onChange={(e) => setSigLabel(e.target.value)}
                        />
                      </div>
                      <div className="esign-color-picker">
                        <span className="ai-provider-label">Ink</span>
                        <div className="esign-color-dots">
                          {SIGN_COLORS.map((c, idx) => (
                            <button
                              key={c.id}
                              type="button"
                              className={`esign-color-dot${idx === sigColorIdx ? ' active' : ''}`}
                              style={{ backgroundColor: c.hex }}
                              title={c.label}
                              aria-label={c.label}
                              onClick={() => setSigColorIdx(idx)}
                            />
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="esign-mode-tabs">
                      <button
                        type="button"
                        className={`esign-mode-tab${sigMode === 'draw' ? ' active' : ''}`}
                        onClick={() => setSigMode('draw')}
                      >
                        Draw
                      </button>
                      <button
                        type="button"
                        className={`esign-mode-tab${sigMode === 'type' ? ' active' : ''}`}
                        onClick={() => setSigMode('type')}
                      >
                        Type
                      </button>
                      <button
                        type="button"
                        className={`esign-mode-tab${sigMode === 'image' ? ' active' : ''}`}
                        onClick={() => setSigMode('image')}
                      >
                        Upload Image
                      </button>
                    </div>

                    {sigMode === 'draw' && (
                      <div className="esign-pad-wrap">
                        <canvas
                          ref={sigPadRef}
                          className="esign-pad-canvas"
                          width={SIGN_PAD_W}
                          height={SIGN_PAD_H}
                          onPointerDown={onPadDown}
                          onPointerMove={onPadMove}
                          onPointerUp={onPadUp}
                          onPointerCancel={onPadUp}
                        />
                        <div className="esign-pad-baseline" />
                        <button type="button" className="esign-pad-clear" onClick={clearSigPad}>
                          Clear
                        </button>
                      </div>
                    )}

                    {sigMode === 'type' && (
                      <div className="esign-type-wrap">
                        <input
                          type="text"
                          className="esign-type-input"
                          value={sigTyped}
                          placeholder="Type your name or initials…"
                          onChange={(e) => setSigTyped(e.target.value)}
                        />
                        <div className="esign-font-grid">
                          {SIGN_FONTS.map((f, idx) => (
                            <button
                              key={f.id}
                              type="button"
                              className={`esign-font-card${idx === sigFontIdx ? ' active' : ''}`}
                              style={{
                                fontFamily: f.family,
                                fontStyle: f.italic ? 'italic' : 'normal',
                                color: activeColor.hex,
                              }}
                              onClick={() => setSigFontIdx(idx)}
                            >
                              {sigTyped.trim() || 'Signature'}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {sigMode === 'image' && (
                      <div className="esign-upload-wrap">
                        <input
                          ref={sigFileRef}
                          type="file"
                          accept="image/*"
                          style={{ display: 'none' }}
                          onChange={(e) => void onPickSigImage(e)}
                        />
                        {processedUpload ? (
                          <div
                            className="esign-upload-box"
                            onClick={() => sigFileRef.current?.click()}
                          >
                            <img src={processedUpload.url} alt="Uploaded signature" />
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="esign-upload-box empty"
                            onClick={() => sigFileRef.current?.click()}
                          >
                            <span>Click to select a signature image (PNG / JPG)</span>
                          </button>
                        )}
                        <label className="esign-bw-toggle">
                          <input
                            type="checkbox"
                            checked={sigBw}
                            onChange={(e) => setSigBw(e.target.checked)}
                          />
                          <span>Remove paper background &amp; apply selected ink color</span>
                        </label>
                      </div>
                    )}

                    <div className="esign-creator-actions">
                      <button
                        type="button"
                        className="ai-provider-btn"
                        onClick={() => setCreatingSig(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="ai-provider-btn primary"
                        disabled={!canSaveNewSig}
                        onClick={() => void saveNewSignature()}
                      >
                        Save to Vault
                      </button>
                    </div>
                  </div>
                ) : prefs.signatures.length === 0 ? (
                  <div className="esign-empty-card">
                    <p>No saved signatures yet.</p>
                    <span>
                      Create a drawn, typed, or uploaded signature once and reuse it across all your
                      PDF documents.
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setCreatingSig(true)}
                    >
                      Create First Signature
                    </button>
                  </div>
                ) : (
                  <div className="esign-list">
                    {prefs.signatures.map((sig) => (
                      <div key={sig.id} className="esign-item-card">
                        <div className="esign-item-preview">
                          <SavedSignaturePreview sig={sig} />
                        </div>
                        <div className="esign-item-meta">
                          <div className="esign-item-title-row">
                            <span className="esign-item-label">{sig.label}</span>
                            {sig.isDefault && <span className="esign-default-badge">Default</span>}
                          </div>
                          <span className="esign-item-sub">
                            {sig.kind === 'strokes' ? 'Vector Ink Signature' : 'Stamp Signature'}
                          </span>
                        </div>
                        <div className="esign-item-actions">
                          {!sig.isDefault && (
                            <button
                              type="button"
                              className="btn-ghost-sm"
                              onClick={() => void setDefaultSignature(sig.id)}
                            >
                              Set Default
                            </button>
                          )}
                          <button
                            type="button"
                            className="esign-delete-btn"
                            title="Delete signature"
                            aria-label={`Delete ${sig.label}`}
                            onClick={() => void deleteSignature(sig.id)}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeSection === 'general' && (
              <div className="settings-section-body">
                <div className="settings-section-intro">
                  <h4>Preferences</h4>
                  <p>Appearance and default reader behavior.</p>
                </div>

                <div className="ai-provider-field">
                  <label className="ai-provider-label">Appearance Theme</label>
                  <div className="settings-segmented">
                    {(['light', 'dark', 'system'] as UiTheme[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`settings-seg-btn${themePref === mode ? ' active' : ''}`}
                        onClick={() => void handleThemeChange(mode)}
                      >
                        {mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'System'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-grid-2">
                  <div className="ai-provider-field">
                    <label htmlFor="pref-default-zoom" className="ai-provider-label">
                      Default PDF Zoom
                    </label>
                    <select
                      id="pref-default-zoom"
                      value={prefs.defaultZoom}
                      onChange={(e) =>
                        setPrefs((prev) => ({
                          ...prev,
                          defaultZoom: e.target.value as ReaderPreferences['defaultZoom'],
                        }))
                      }
                    >
                      <option value="fit-width">Fit Page Width</option>
                      <option value="fit-page">Fit Whole Page</option>
                      <option value="100">100% Actual Size</option>
                      <option value="125">125% Comfortable Read</option>
                    </select>
                  </div>

                  <div className="ai-provider-field">
                    <label htmlFor="pref-default-sidebar" className="ai-provider-label">
                      Default Left Panel
                    </label>
                    <select
                      id="pref-default-sidebar"
                      value={prefs.defaultSidebar}
                      onChange={(e) =>
                        setPrefs((prev) => ({
                          ...prev,
                          defaultSidebar: e.target.value as ReaderPreferences['defaultSidebar'],
                        }))
                      }
                    >
                      <option value="none">Collapsed (Maximum Canvas)</option>
                      <option value="thumbs">Page Thumbnails</option>
                      <option value="outline">Document Outline (Bookmarks)</option>
                    </select>
                  </div>
                </div>

                <label className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">
                      Auto-save PDF annotations &amp; forms
                    </div>
                    <div className="settings-toggle-desc">
                      Automatically write highlights, notes, and form edits back to the open file.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={prefs.autosave}
                    onChange={(e) => setPrefs((prev) => ({ ...prev, autosave: e.target.checked }))}
                  />
                </label>

                <label className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">
                      Adaptive AI recommendations on document open
                    </div>
                    <div className="settings-toggle-desc">
                      Automatically gather document context when opening a PDF to suggest tailored
                      AI prompts in the assistant panel.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={prefs.aiAutoSuggestions !== false}
                    onChange={(e) => {
                      const next = { ...prefs, aiAutoSuggestions: e.target.checked }
                      void persistPrefs(next)
                    }}
                  />
                </label>

                <div className="settings-maintenance-row">
                  <div>
                    <div className="settings-toggle-title">Application Updates</div>
                    <div className="settings-toggle-desc">
                      Check GitHub Releases for a newer version of ARAReader.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost-sm"
                    onClick={() => {
                      void window.reader.checkForUpdates()
                      setSavedNotice('Checking for updates in the background…')
                      setTimeout(() => setSavedNotice(''), 2500)
                    }}
                  >
                    Check for Updates
                  </button>
                </div>
                {savedNotice && <div className="settings-inline-notice">{savedNotice}</div>}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="ai-provider-error" role="alert">
            <AlertIcon />
            <span>{error}</span>
          </div>
        )}

        <div className="ai-provider-actions">
          <button type="button" className="ai-provider-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-provider-btn primary"
            onClick={() => void saveAll()}
            disabled={!loaded || saving}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
