import type { Lang } from '@arareader/i18n'
import type {
  AiChatResponse,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
} from '@arareader/ai-provider'
import type { ProjectApi } from '@arareader/project-store'

/**
 * Accessibility report, drawn from the file only: automated verdicts plus honest "manual" marks
 * where the answer is not in the file (contrast, reading order, screen flicker). Report only.
 */
export type A11yRuleId =
  'title' | 'language' | 'tagged' | 'altFigures' | 'bookmarksLong' | 'headings' | 'tables' | 'forms'

export interface A11yRuleResult {
  rule: A11yRuleId
  verdict: 'pass' | 'fail' | 'manual'
  /** The renderer localizes when the verdict needs a number on screen */
  count?: number
}

export interface A11yReport {
  pageCount: number
  rules: A11yRuleResult[]
}

export const PDF_CHANNELS = {
  consumePending: 'pdf:consume-pending',
  readFile: 'pdf:read-file',
  save: 'pdf:save',
  menuCommand: 'pdf:menu-command',
  fileChanged: 'pdf:file-changed',
  pickSavePath: 'pdf:pick-save-path',
  openInNewTab: 'pdf:open-in-new-tab',
  extractPages: 'pdf:extract-pages',
  insertPdf: 'pdf:insert-pdf',
  insertBlankPage: 'pdf:insert-blank-page',
  duplicatePages: 'pdf:duplicate-pages',
  exportImages: 'pdf:export-images',
  exportText: 'pdf:export-text',
  exportEmbeddedImages: 'pdf:export-embedded-images',
  setOutline: 'pdf:set-outline',
  a11yCheck: 'pdf:a11y-check',
  a11yFix: 'pdf:a11y-fix',
  splitPdf: 'pdf:split-pdf',
  combinePdfs: 'pdf:combine-pdfs',
  sanitizePdf: 'pdf:sanitize-pdf',
  sanitizePreview: 'pdf:sanitize-preview',
  deleteAnnotations: 'pdf:delete-annotations',
  dirtyChanged: 'pdf:dirty-changed',
  readModeChanged: 'pdf:read-mode-changed',
  exitReadMode: 'pdf:exit-read-mode',
  viewModeChanged: 'pdf:view-mode-changed',
  setViewMode: 'pdf:set-view-mode',
  spreadChanged: 'pdf:spread-changed',
  setSpread: 'pdf:set-spread',
  closeSaveRequest: 'pdf:close-save-request',
  closeSaveResult: 'pdf:close-save-result',
  closePromptChanged: 'pdf:close-prompt-changed',
  closePromptReady: 'pdf:close-prompt-ready',
  getLanguage: 'app:get-language',
  languageChanged: 'app:language-changed',
  getPreferences: 'home:get-preferences',
  setPreferences: 'home:set-preferences',
  preferencesChanged: 'home:preferences-changed',
} as const

/** Saved e-signature shared between Settings (Home) and the PDF SignatureDialog */
export interface SavedSignatureItem {
  id: string
  label: string
  kind: 'strokes' | 'image'
  paths?: number[][]
  image?: string
  width: number
  height: number
  color?: [number, number, number]
  createdAt: number
  isDefault?: boolean
}

export interface SharedUserPreferences {
  profile: {
    displayName: string
    fullName: string
    title: string
    organization: string
    email: string
    useAsDefaultAuthor: boolean
  }
  signatures: SavedSignatureItem[]
  starredPaths: string[]
  defaultZoom: 'fit-width' | 'fit-page' | '100' | '125'
  defaultSidebar: 'none' | 'thumbs' | 'outline'
  autosave: boolean
  /** Auto-gather document context on first open to generate AI-tailored recommendations */
  aiAutoSuggestions?: boolean
  /** Present only after the user explicitly chose the automatic-sharing preference. */
  aiAutoSuggestionsConsentVersion?: 1
  /** One-write signal for the main process to accept a deliberate checkbox choice. */
  aiAutoSuggestionsConsentAction?: boolean
  /** Whether the user has seen or completed the initial onboarding modal */
  onboardingCompleted?: boolean
}

/** File-menu command the host routes into the active PDF view */
export type PdfMenuCommand = 'save' | 'save-as' | 'print'

/**
 * What sanitize may remove, one flag per category. Each is safe to rewrite with pdf-lib; the
 * categories that need content-stream surgery (invisible text, hidden layers) are absent
 * deliberately rather than half-implemented.
 */
export interface SanitizeRequest {
  /** /Info fields (blanked) and the XMP /Metadata stream (dropped) */
  metadata: boolean
  /** Catalog /OpenAction, /AA and /Names /JavaScript */
  javascript: boolean
  /** Embedded files (/Names /EmbeddedFiles, /Collection) */
  attachments: boolean
  /** Page /Annots — markup comments, links and their actions; widget annotations stay */
  comments: boolean
  /** Page /Thumb */
  thumbnails: boolean
  /** /PieceInfo, in the catalog and on each page */
  privateData: boolean
}

/** How much of each category a sanitize run removed, for reporting after the fact */
export type SanitizeReport = Record<keyof SanitizeRequest, number>

export interface SanitizePdfRequest extends SanitizeRequest {
  /** The path rewritten in place; the same grant check every other write goes through */
  path: string
}

export type SanitizeResult = { ok: true; report: SanitizeReport } | { ok: false; error: string }

/** Read-only census for the sanitize dialog: runs the removal walk without applying it */
export interface SanitizePreviewRequest {
  path: string
}

export type SanitizePreviewResult =
  { ok: true; counts: SanitizeReport } | { ok: false; error: string }

/** Identity of one annotation as the renderer saw it; pdf.js ids are synthesized and unstable,
 * so the file-side match keys on the decoded fields instead. Shared here because both sides
 * speak it. */
export interface AnnotMatch {
  /** 0-based page index in the saved file */
  pageIndex: number
  /** decoded /Subtype, e.g. Text, Highlight, FreeText */
  subtype: string
  /** /Rect as [x1, y1, x2, y2] in the annotation's user space */
  rect: number[]
  /** decoded /Contents, normalized: absent and empty are the same */
  contents: string
  /** decoded /NM when present */
  name: string
}

/** Comments-panel deletion: refusals are whole-batch so the file never half-matches the panel */
export interface DeleteAnnotationsRequest {
  path: string
  targets: AnnotMatch[]
}

export type DeleteAnnotationsResult = { ok: true } | { ok: false; error: string }

/** Report-only accessibility scan; no file writes, same grant model as the other reads */
export interface A11yCheckRequest {
  path: string
}

export type A11yCheckResult = { ok: true; report: A11yReport } | { ok: false; error: string }

/** Fill the report's two metadata gaps: /Info title (from the file name) and catalogue /Lang */
export interface A11yFixRequest {
  /** The granted path the fix rewrites in place */
  path: string
  /** BCP-47-ish tag written when the catalogue has no /Lang */
  lang: string
}

export type A11yFixResult = { ok: true; fixed: number } | { ok: false; error: string }

export type MarkupType = 'highlight' | 'underline' | 'strikeout' | 'squiggly'

/** Minimum coordinate count in DrawingInput.points: 2 points open, 3 points closed.
    Shared so the renderer stops collecting and the writer refuses malformed input on the same rule. */
export const MIN_POLY_POINTS: Record<'polyline' | 'polygon', number> = {
  polyline: 4,
  polygon: 6,
}

/** A text markup to write; quads are 4-point groups in PDF coords (y up) [x1,yTop,x2,yTop,x1,yBottom,x2,yBottom] */
export interface MarkupInput {
  pageIndex: number
  type: MarkupType
  /** rgb normalized to 0-1 */
  color: [number, number, number]
  quads: number[][]
}

/** Drawing annotations (all coords in PDF user space, y up).
    One union member per kind; a union-literal kind would break TS narrowing. */
interface DrawBase {
  pageIndex: number
  color: [number, number, number]
  width: number
}

export type DrawingInput =
  | (DrawBase & {
      kind: 'ink'
      /** Each stroke as [x1,y1,x2,y2,...] */
      paths: number[][]
    })
  | (DrawBase & { kind: 'rect'; rect: [number, number, number, number] })
  | (DrawBase & { kind: 'ellipse'; rect: [number, number, number, number] })
  | (DrawBase & { kind: 'line'; from: [number, number]; to: [number, number] })
  | (DrawBase & {
      /** Open connected lines; flat [x1,y1,x2,y2,...], at least 2 points */
      kind: 'polyline'
      points: number[]
    })
  | (DrawBase & {
      /** Closed polygon; flat [x1,y1,x2,y2,...], at least 3 points */
      kind: 'polygon'
      points: number[]
    })
  | {
      /** Insertion-point caret, as a replace-text proposal uses */
      kind: 'caret'
      pageIndex: number
      color: [number, number, number]
      /** Insertion point at the base of the caret, PDF user space y up */
      at: [number, number]
      /** Line height the caret spans */
      size: number
      contents: string
    }
  | (DrawBase & { kind: 'arrow'; from: [number, number]; to: [number, number] })
  | {
      /** Image signature/stamp placed by the user; written as a Stamp annotation */
      kind: 'image'
      pageIndex: number
      /** base64 PNG, without the data: prefix */
      image: string
      /** PDF user space [x1,y1,x2,y2] */
      rect: [number, number, number, number]
    }
  | {
      /** Typewriter text; written as a FreeText annotation whose appearance is the rasterized
          glyphs, so CJK works despite pdf-lib's WinAnsi-only built-in fonts */
      kind: 'freetext'
      pageIndex: number
      /** base64 PNG, without the data: prefix */
      image: string
      /** PDF user space [x1,y1,x2,y2] */
      rect: [number, number, number, number]
      /** The typed text, kept in /Contents so the comment stays listable and searchable */
      contents: string
    }
  | {
      kind: 'note'
      pageIndex: number
      color: [number, number, number]
      at: [number, number]
      contents: string
    }

/**
 * Stamp layer (watermark/header/footer/page numbers all go through it).
 * The renderer rasterizes the bitmap via canvas (with rotation and fonts, bypassing
 * pdf-lib's lack of CJK support); the main process only embeds and positions it.
 */
export interface StampInput {
  pageIndex: number
  /** base64 PNG, without the data: prefix */
  image: string
  /** PDF user space [x1,y1,x2,y2] */
  rect: [number, number, number, number]
  opacity?: number
  /** Content-edit image: counter-rotate against the page /Rotate so it displays upright.
      Watermark/header stamps leave this off and stay page-space. */
  upright?: boolean
}

/** Document info; an empty string clears the field */
export interface MetadataInput {
  title?: string
  author?: string
  subject?: string
  keywords?: string
}

export interface FormValueInput {
  name: string
  kind: 'text' | 'checkbox' | 'radio' | 'choice'
  /** For radio: selected exportValue; for choice: selected option; empty string clears selection */
  value?: string
  checked?: boolean
}

export interface SavePdfRequest {
  path: string
  /**
   * Save As destination. When set, `path` is only read (source bytes) and the edited PDF
   * is written to this path instead — the original file must never be mutated.
   * Must match the target granted to the view by the main process (save dialog pick).
   */
  targetPath?: string
  markups: MarkupInput[]
  drawings: DrawingInput[]
  formValues: FormValueInput[]
  stamps: StampInput[]
  /** Page rotation deltas (original page index → multiple of 90 clockwise) */
  rotations?: { pageIndex: number; delta: number }[]
  /** Pages to delete (original page indices) */
  deletedPages?: number[]
  /** New page order (array of original page indices, excluding deleted); omitted if unreordered */
  pageOrder?: number[]
  metadata?: MetadataInput
}

export type SavePdfResult = { ok: true; warning?: string } | { ok: false; error: string }

/** Extract pages into a new PDF: main process shows a save dialog; cancel returns canceled */
export interface ExtractPagesRequest {
  path: string
  /** Original page indices */
  pages: number[]
  suggestedName: string
}

export type ExtractPagesResult =
  { ok: true; savedPath: string } | { ok: true; canceled: true } | { ok: false; error: string }

/** Insert (merge) another PDF after a page of the current file: main process shows a picker and writes back immediately */
export interface InsertPdfRequest {
  path: string
  /** Insert after this original page index; -1 means front of the document */
  afterPageIndex: number
}

export type InsertPdfResult =
  { ok: true; insertedCount: number } | { ok: true; canceled: true } | { ok: false; error: string }

/** Insert one blank page in place, sized like the page it follows; no dialog, no new file */
export interface InsertBlankPageRequest {
  path: string
  /** Insert after this original page index; -1 means front of the document */
  afterPageIndex: number
}

/** pageIndex is the new page's 0-based position in the rewritten file */
export type InsertBlankPageResult = { ok: true; pageIndex: number } | { ok: false; error: string }

/** Copy pages in place, each copy directly after its source */
export interface DuplicatePagesRequest {
  path: string
  /** Original page indices; values outside the document are ignored */
  pageIndices: number[]
}

/** count is how many copies were written (invalid indices contribute nothing) */
export type DuplicatePagesResult = { ok: true; count: number } | { ok: false; error: string }

/** Export pages as PNG: renderer rasterizes the bitmaps, main process shows a dialog and writes to disk */
export interface ExportImagesRequest {
  /** base64 PNGs (without the data: prefix), in page order */
  images: string[]
  /** 1-based page numbers, same length as images, used for file names */
  pageNumbers: number[]
  baseName: string
}

export type ExportImagesResult =
  | { ok: true; savedDir: string; count: number }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

/** Export the document's text: main process shows a save dialog and writes it */
export interface ExportTextRequest {
  /** Plain text, page-marker separated */
  text: string
  suggestedName: string
}

export type ExportTextResult =
  { ok: true; savedPath: string } | { ok: true; canceled: true } | { ok: false; error: string }

/** Split into one file per range; main process shows a directory picker and writes them there */
export interface SplitPdfRequest {
  path: string
  /** One entry per output file, as original 0-based page indices */
  ranges: number[][]
  /** File name stem; each part gets a -01/-02 suffix */
  baseName: string
}

export type SplitPdfResult =
  | { ok: true; savedDir: string; count: number }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

/** Merge several PDFs; the main process picks the files (multi-select), merges and saves */
export interface CombinePdfsRequest {
  /** Add one bookmark per source file, titled with its name */
  bookmarkPerFile: boolean
}

export type CombinePdfsResult =
  | { ok: true; savedPath: string; fileCount: number }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

/** Export the file's embedded images: main process shows a folder picker and writes them there */
export interface ExportEmbeddedImagesRequest {
  path: string
}

export type ExportEmbeddedImagesResult =
  | { ok: true; savedDir: string; count: number; skipped: number }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

/** Replace the document's outline with this tree; empty nodes clears it entirely */
export interface OutlineEditNode {
  title: string
  /** 0-based page index the bookmark jumps to; ignored when uri is set */
  pageIndex: number
  /** Kept for web and mailto bookmarks, which get a /URI action instead of a destination */
  uri?: string
  children?: OutlineEditNode[]
}

export interface SetOutlineRequest {
  path: string
  nodes: OutlineEditNode[]
}

export type SetOutlineResult = { ok: true } | { ok: false; error: string }

/** AI channels are app-wide shared ipcMain handlers (the desktop host registers them); pass-through only */
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

/**
 * Attachment channels. Must stay identical to the desktop host's
 * `shared/ai-api.ts` FILES_CHANNELS — the main process owns the handlers.
 */
export const FILES_CHANNELS = {
  pick: 'files:pick',
  add: 'files:add',
  read: 'files:read',
  readImage: 'files:read-image',
  addPastedImage: 'files:add-pasted-image',
} as const

/**
 * Per-document chat history channels. Must stay identical to the desktop host's
 * `shared/ai-api.ts` PROJECT_CHANNELS — the main process owns the handlers.
 */
export const PROJECT_CHANNELS = {
  resolveChat: 'project:resolveChat',
  appendChat: 'project:appendChat',
  loadChat: 'project:loadChat',
  rebindChat: 'project:rebindChat',
  startNewChat: 'project:startNewChat',
} as const

/** Extensions sent multimodally as images rather than parsed as text */
export const ATTACHMENT_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** One local file attached to the chat; the file never leaves the machine unless the model asks */
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
  /** Paths requiring a fresh user selection during revalidation. */
  ungranted?: string[]
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

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

/** ai:web-search response; `method: 'error'` means the backend failed (not an empty result) */
export interface WebSearchResponse {
  results: WebSearchResult[]
  answer?: string
  method: string
  /** failure reason when method === 'error' */
  error?: string
}

export interface WebFetchResult {
  title: string
  url: string
  content: string
  isError?: boolean
}

/** API exposed by preload to the renderer (window.pdfApi) */
export interface PdfApi {
  /** Take the pdf path pending for this view (queued at tab creation); null if none */
  consumePending(): Promise<string | null>
  /** Read pdf bytes. Only paths granted to this view are allowed */
  readFile(path: string): Promise<ArrayBuffer>
  /** Write markups/form values/page ops back to the original file (pdf-lib, content streams untouched); path grants same as readFile. With targetPath set (Save As), the original is only read and the result goes to targetPath */
  save(request: SavePdfRequest): Promise<SavePdfResult>
  /** Host File menu (Save / Save As / Print accelerators) routed to this view; returns an unsubscribe */
  onMenuCommand(handler: (command: PdfMenuCommand) => void): () => void
  /** Fires when the granted file changes on disk (an external LaTeX/Typst rebuild); returns an unsubscribe */
  onFileChanged(handler: (path: string) => void): () => void
  /** Save As target picker shown by the main process; null when the user cancels */
  pickSavePath(suggestedName: string): Promise<string | null>
  extractPages(request: ExtractPagesRequest): Promise<ExtractPagesResult>
  insertPdf(request: InsertPdfRequest): Promise<InsertPdfResult>
  insertBlankPage(request: InsertBlankPageRequest): Promise<InsertBlankPageResult>
  duplicatePages(request: DuplicatePagesRequest): Promise<DuplicatePagesResult>
  exportImages(request: ExportImagesRequest): Promise<ExportImagesResult>
  exportText(request: ExportTextRequest): Promise<ExportTextResult>
  exportEmbeddedImages(request: ExportEmbeddedImagesRequest): Promise<ExportEmbeddedImagesResult>
  setOutline(request: SetOutlineRequest): Promise<SetOutlineResult>
  a11yCheck(request: A11yCheckRequest): Promise<A11yCheckResult>
  a11yFix(request: A11yFixRequest): Promise<A11yFixResult>
  splitPdf(request: SplitPdfRequest): Promise<SplitPdfResult>
  combinePdfs(request: CombinePdfsRequest): Promise<CombinePdfsResult>
  sanitizePdf(request: SanitizePdfRequest): Promise<SanitizeResult>
  sanitizePreview(request: SanitizePreviewRequest): Promise<SanitizePreviewResult>
  deleteAnnotations(request: DeleteAnnotationsRequest): Promise<DeleteAnnotationsResult>
  /** Mirror unsaved-changes state to the main process; drives the save prompt before closing a tab/window */
  setDirty(dirty: boolean): void
  setReadMode(reading: boolean): void
  onExitReadMode(handler: () => void): () => void
  /** Publish the paged/continuous view state so the host tab strip can mirror it */
  setViewModeState(paged: boolean): void
  /** Host requests an explicit view mode (read-mode header switch) */
  onSetViewMode(handler: (paged: boolean) => void): () => void
  setSpreadState(spread: 1 | 2): void
  onSetSpread(handler: (spread: 1 | 2) => void): () => void
  /** Main process picked "Save" in the close prompt → renderer saves and replies via sendCloseSaveResult */
  onCloseSaveRequest(handler: () => void): () => void
  sendCloseSaveResult(ok: boolean): void
  /** Main-process close confirmation pauses automatic saves until the view is released. */
  onClosePromptChanged(handler: (active: boolean, discardAutosave: boolean) => void): () => void
  sendClosePromptReady(): void
  getLanguage(): Promise<Lang>
  onLanguageChanged(handler: (lang: Lang) => void): () => void
  getPreferences?: () => Promise<SharedUserPreferences>
  setPreferences?: (prefs: SharedUserPreferences) => Promise<SharedUserPreferences>
  onPreferencesChanged?: (handler: (prefs: SharedUserPreferences) => void) => () => void
  /** redacted settings: the renderer never receives apiKey, only hasApiKey */
  getAiSettings(): Promise<AiSettings>
  /** open the host's AI provider settings (no accounts: configuring a provider is the only setup) */
  configureAi: () => Promise<void>
  onAiSettingsChanged(handler: (settings: AiSettings) => void): () => void
  aiStream(request: AiStreamRequest): Promise<void>
  aiStreamCancel(requestId: string): Promise<void>
  onAiStream(handler: (chunk: AiStreamChunk) => void): () => void
  aiChat?: (request: { system: string; user: string }) => Promise<AiChatResponse>
  /** chat attachments: file picker (multi-select); null when the user cancels */
  pickAttachments(purpose?: 'reselect'): Promise<AttachmentAddResult | null>
  /** Revalidate paths already granted to this view; never grants a new path. */
  addAttachmentPaths(paths: string[]): Promise<AttachmentAddResult>
  /** persist a pasted clipboard image (no local path) to a temp file and add it as an attachment */
  addPastedImage(data: ArrayBuffer, ext: string): Promise<AttachmentAddResult>
  /** read a slice of an attachment's locally extracted text */
  readAttachment(path: string, offset: number, maxChars: number): Promise<AttachmentReadResult>
  /** read an image attachment as base64 for multimodal input (≤5MB) */
  readAttachmentImage(path: string): Promise<AttachmentImageResult>
  /** absolute path of a File dropped onto the window (Electron webUtils) */
  getPathForFile(file: File): string
  webSearch(query: string, maxResults?: number): Promise<WebSearchResponse>
  webFetch(url: string): Promise<WebFetchResult>
}

/** Per-document chat history the PDF preload exposes as window.pdfProject */
export type PdfProjectApi = Pick<
  ProjectApi,
  'resolveChat' | 'appendChat' | 'loadChat' | 'rebindChat' | 'startNewChat'
>
