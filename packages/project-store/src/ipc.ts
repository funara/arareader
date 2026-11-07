/**
 * IPC interface type definitions (shared by the renderer and main processes).
 * No Electron dependency; importable from the renderer.
 */
import type {
  ChatAttachment,
  ChatMessage,
  ChatMeta,
  ProjectSummary,
  ToolActivity,
} from './types.js'

export type { ChatAttachment, ChatMessage, ChatMeta, ProjectSummary, ToolActivity }

export interface AppendChatArgs {
  projectId: string
  chatId: string
  role: 'user' | 'assistant'
  text: string
  /** Terminal state of this assistant turn; absent = complete reply */
  status?: 'stopped' | 'failed'
  tools?: ToolActivity[]
  attachments?: ChatAttachment[]
}

/**
 * Validate an untrusted `project:appendChat` payload (IPC args arrive untyped).
 * Returns null when the payload is unusable. `status` is only forwarded when it
 * is one of the two known terminal states, so a bad value can never be written
 * into a transcript.
 */
export function parseAppendChatArgs(
  args: unknown,
): { projectId: string; chatId: string; message: Omit<ChatMessage, 'seq' | 'ts'> } | null {
  if (!args || typeof args !== 'object') return null
  const input = args as Partial<AppendChatArgs>
  if (typeof input.projectId !== 'string' || typeof input.chatId !== 'string') return null
  if (typeof input.text !== 'string') return null
  if (input.role !== 'user' && input.role !== 'assistant') return null
  const message: Omit<ChatMessage, 'seq' | 'ts'> = { role: input.role, text: input.text }
  if (input.status === 'stopped' || input.status === 'failed') message.status = input.status
  if (Array.isArray(input.tools) && input.tools.length > 0) message.tools = input.tools
  if (Array.isArray(input.attachments) && input.attachments.length > 0) {
    message.attachments = input.attachments
  }
  return { projectId: input.projectId, chatId: input.chatId, message }
}

export interface LoadChatArgs {
  projectId: string
  chatId: string
  limit?: number
}

export interface ResolveChatArgs {
  /** Absolute path of the currently open file; null means an unsaved new file */
  filePath: string | null
  /** Temp chatId for unsaved files, e.g. "unsaved-<timestamp>" */
  tempChatId?: string
  /** Sheets mode: look up the file path by sessionId (handled in the main process) */
  sessionId?: string
}

export interface ResolveChatResult {
  projectId: string
  chatId: string
  /**
   * First seq of the active conversation. `0`/absent means nothing was ever cut;
   * a caller that gets an absent value from a failed rebind must treat the
   * boundary as *unknown* (not 0) and refuse to guess the active conversation.
   */
  boundarySeq?: number
}

export interface StartNewChatArgs {
  projectId: string
  chatId: string
}

export interface StartNewChatResult extends ResolveChatResult {
  /** First seq of the new conversation (messages below it are the earlier conversation) */
  boundarySeq: number
}

export interface RebindChatArgs {
  projectId: string
  tempChatId: string
  /** Specify the new chatId directly; one of newChatId / newFilePath / sessionId */
  newChatId?: string
  /** File path where the unsaved session first hit disk: the main process derives the chatId from it and registers fileMap */
  newFilePath?: string
  /** Sheets mode: the renderer can't get the path, so it passes sessionId for the main process to look up and rebind */
  sessionId?: string
}

// ── P1 extensions ──────────────────────────────────────────

export interface CreateProjectArgs {
  name: string
}

export interface RenameProjectArgs {
  id: string
  name: string
}

export interface DeleteProjectArgs {
  id: string
}

export interface MoveFileArgs {
  filePath: string
  projectId: string
}

/** Project storage API the main process exposes to the renderer */
export interface ProjectApi {
  /**
   * Resolves projectId and chatId from a file path.
   * When filePath is null, returns the default project + tempChatId (if provided).
   */
  resolveChat(args: ResolveChatArgs): Promise<ResolveChatResult>
  /** Appends one message; false means persistence failed, including validation failures. */
  appendChat(args: AppendChatArgs): Promise<boolean>
  /** Reads the most recent `limit` messages */
  loadChat(args: LoadChatArgs): Promise<ChatMessage[]>
  /**
   * Starts a fresh conversation for this chat: later messages belong to it, all
   * earlier ones stay on disk as the earlier conversation (nothing is deleted).
   */
  startNewChat(args: StartNewChatArgs): Promise<StartNewChatResult>
  /** Renames the JSONL file (called after the file first hits disk); returns the new projectId/chatId */
  rebindChat(args: RebindChatArgs): Promise<ResolveChatResult>
  // ── P1 extensions ──
  /** Lists all projects (with file count + last active time) */
  listProjects(): Promise<ProjectSummary[]>
  /** Creates a project */
  createProject(args: CreateProjectArgs): Promise<ProjectSummary>
  /** Renames a project */
  renameProject(args: RenameProjectArgs): Promise<void>
  /** Soft-deletes a project (directory moved into .trash) */
  deleteProject(args: DeleteProjectArgs): Promise<void>
  /** Moves a file into the given project */
  moveFile(args: MoveFileArgs): Promise<void>
}
