/**
 * project-store type definitions.
 * Mirrors the cloud project model, implemented on the local filesystem.
 */

// ────────────────────────────────────────────────────────────
// Tool types
// ────────────────────────────────────────────────────────────

/** A structured source link recorded with a tool call (untrusted; bounded by the store) */
export interface ToolLink {
  url: string
  title?: string
}

export interface ToolActivity {
  name: string
  summary: string
  isError?: boolean
  /** Queued but not executed (run stopped / stuck / over budget) */
  skipped?: boolean
  /** The tool changed the document (used for recovery decisions after a reload) */
  mutated?: boolean
  /** Tool input (JSON-serialized; truncated by the store layer) */
  input?: string
  /** Tool output (truncated by the store layer) */
  output?: string
  /**
   * Source links the tool returned (web search / fetch), so a restored transcript
   * can show its sources without re-parsing the output. Rendered through the
   * existing http/https allowlist; bounded by the store.
   */
  links?: ToolLink[]
}

/** Attachment metadata recorded with a user message (reference only, no bytes; moving/deleting the file just breaks the link) */
export interface ChatAttachment {
  name: string
  /** Absolute local path (if any) */
  path?: string
  /** Lowercase extension, no dot */
  ext?: string
  sizeBytes?: number
}

// ────────────────────────────────────────────────────────────
// Message structures
// ────────────────────────────────────────────────────────────

/**
 * One JSONL line corresponds to one message.
 * ts: UTC ISO string
 * seq: monotonically increasing integer within a chat (maintained by the store; the renderer sorts by seq)
 * attachments: not implemented in P0, field reserved only
 */
export interface ChatMessage {
  seq: number
  ts: string
  role: 'user' | 'assistant'
  text: string
  /** File path associated with the message */
  fileRef?: string
  /**
   * Terminal state of an assistant turn. Absent means a complete reply
   * (every record written before this field existed reads the same way).
   */
  status?: 'stopped' | 'failed'
  /** Tool activity (with truncated inputs/outputs) */
  tools?: ToolActivity[]
  /** Attachment metadata of a user message */
  attachments?: ChatAttachment[]
}

// ────────────────────────────────────────────────────────────
// Project & index structures
// ────────────────────────────────────────────────────────────

export interface ProjectInfo {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export interface ProjectData extends ProjectInfo {
  files: string[]
}

export interface ProjectIndex {
  projects: ProjectInfo[]
  /** absolute path → projectId */
  fileMap: Record<string, string>
  /**
   * Absolute path → stable chatId (registered on first resolve).
   * Once assigned, a chatId never changes with the path; renaming/moving a file
   * only updates the key here, so history follows the file.
   * Old data without this map falls back to sha256(path) derivation.
   */
  chatIdByPath?: Record<string, string>
  /**
   * chatId → first seq of the active conversation. Messages with a smaller seq
   * are the earlier conversation: kept on disk, shown separately, never fed to
   * the model as context. Absent means the whole transcript is one conversation.
   */
  chatBoundaryByChatId?: Record<string, number>
}

export interface ChatMeta {
  chatId: string
  /** Last modification time of the JSONL file (UTC ISO) */
  updatedAt: string
  /** Approximate line count (estimated from file bytes, not exact) */
  approxCount: number
}

// ────────────────────────────────────────────────────────────
// Extended API types (P1)
// ────────────────────────────────────────────────────────────

/**
 * Summary info returned by listProjects() (with aggregated fields)
 */
export interface ProjectSummary extends ProjectInfo {
  /** Number of files currently belonging to this project */
  fileCount: number
  /** Last active time: max of project.json updatedAt and all chat mtimes */
  lastActiveAt: string
  /** Whether this is the default project (cannot be deleted/renamed) */
  isDefault: boolean
}
