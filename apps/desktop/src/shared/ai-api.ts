/// Shared AI contract between the desktop main process, the host preload, and
/// the PDF module: channel names, renderer-facing API shapes, and attachment
/// metadata types. No renderer or Electron imports here — this module is safe
/// to import from main, preload, and renderer alike.
///
/// The main process owns these handlers (see main/ai-bridge.ts); the PDF module
/// and the host renderer are pass-through clients over the same channels.

import type { AiSettings, AiStreamChunk, AiStreamRequest } from '@arareader/ai-provider'
import type { ProjectApi } from '@arareader/project-store'

/** AI channels. Names are a cross-module contract: never rename them. */
export const AI_CHANNELS = {
  getSettings: 'ai:get-settings',
  setSettings: 'ai:set-settings',
  settingsChanged: 'ai:settings-changed',
  configure: 'ai:configure',
  configureRequest: 'ai:configure-request',
  fetchCustomModels: 'ai:fetch-custom-models',
  stream: 'ai:stream',
  streamChunk: 'ai:stream-chunk',
  streamCancel: 'ai:stream-cancel',
  cancel: 'ai:cancel',
  webSearch: 'ai:web-search',
  webFetch: 'ai:web-fetch',
  chat: 'ai:chat',
} as const

/** Attachment channels (main-process file access granted per WebContents). */
export const FILES_CHANNELS = {
  pick: 'files:pick',
  add: 'files:add',
  read: 'files:read',
  readImage: 'files:read-image',
  addPastedImage: 'files:add-pasted-image',
} as const

/** Per-document chat history channels (project-store backed). */
export const PROJECT_CHANNELS = {
  resolveChat: 'project:resolveChat',
  appendChat: 'project:appendChat',
  loadChat: 'project:loadChat',
  rebindChat: 'project:rebindChat',
} as const

/** Lowercased image extensions sent to the model multimodally (no text extraction). */
export const ATTACHMENT_IMAGE_EXTS: Set<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** One accepted attachment: the file never leaves the machine. */
export interface AttachmentMeta {
  /** absolute local path */
  path: string
  name: string
  /** lowercased extension without the dot */
  ext: string
  sizeBytes: number
}

export interface AttachmentAddResult {
  accepted: AttachmentMeta[]
  /** per-file rejection messages (too large / unsupported type / unreadable) */
  rejected: string[]
}

export interface AttachmentReadResult {
  ok: boolean
  error?: string
  name?: string
  /** total characters of the extracted text */
  totalChars?: number
  /** requested slice */
  text?: string
  offset?: number
}

/** an image attachment read as raw bytes for multimodal input (files:read-image) */
export interface AttachmentImageResult {
  ok: boolean
  /** raw base64 (no data: URL prefix) */
  base64?: string
  mime?: string
  error?: string
}

/** Result of probing an OpenAI-compatible endpoint for its model list. */
export interface FetchModelsResult {
  ok: boolean
  models: string[]
  error?: string
}

/** `window.readerAi` (host home screen) — every read is redacted, keys stay in main. */
export interface ReaderAiApi {
  getSettings(): Promise<AiSettings>
  setSettings(settings: AiSettings): Promise<void>
  fetchCustomModels(override?: { baseUrl?: string; apiKey?: string }): Promise<FetchModelsResult>
  /** ask the host to open the AI provider dialog (activate Home + send ai:configure-request) */
  configure(): Promise<void>
  onSettingsChanged(handler: (settings: AiSettings) => void): () => void
  /** host-local: a PDF view's unconfigured card asked for provider setup */
  onConfigureRequest(handler: () => void): () => void
}

/** `window.readerProject` (PDF views) — the four read/write history calls. */
export type ReaderProjectApi = Pick<
  ProjectApi,
  'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat'
>

export type { AiSettings, AiStreamChunk, AiStreamRequest }
