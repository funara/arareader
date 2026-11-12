import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  formatSearchResults,
  searchResultLinks,
  type AgentToolCall,
  type AgentToolDef,
  type ToolExecution,
} from '@arareader/agent-core'
import type { OutlineNode } from '../OutlinePanel'
import type { PageGeom } from '../annotations'
import { buildTextEdit, extractPageTextBlocks } from '../content-edit'
import type { PageContentEdit } from '../content-edit'
import type { SearchIndex } from '../search'
import { searchInIndex } from '../search'
import type {
  FormValueInput,
  MarkupType,
  MetadataInput,
  OutlineEditNode,
  WebFetchResult,
  WebSearchResponse,
} from '../../shared/ipc'
import { t } from '../i18n/locale'

/** Text cap per read_pages fed back to the model (the payload is resent in full each turn, so volume must be limited) */
const READ_CHUNK_CHARS = 24_000
const MAX_MATCHES = 40

/** Highlighting a whole document can bury the model in annotations; match count is the guard */
const MAX_MARKUPS = 50

/** An AI-written outline deeper or larger than this is almost certainly a mistake */
const MAX_OUTLINE_DEPTH = 8
const MAX_OUTLINE_NODES = 500

/** Text lines quoted back to the model when a find string does not match the page */
const MAX_LISTED_LINES = 20

/** pdfjs AnnotationType.WIDGET — form fields render as widget annotations */
const WIDGET = 20

interface WidgetAnnotation {
  fieldName?: string
  fieldValue?: unknown
  checkBox?: boolean
  radioButton?: boolean
  options?: { exportValue?: unknown }[]
  readOnly?: boolean
}

/** Capability surface App provides to AI tools; all getters, since the loop outlives render closures */
export interface PdfSkillDeps {
  doc(): PDFDocumentProxy | null
  fileName(): string
  pageCount(): number
  /** Original page number of the currently visible page (1-based) */
  currentPage(): number
  readOnly(): boolean
  beginEdit?(): (() => void) | null
  outline(): OutlineNode[] | null
  searchIndex(): Promise<SearchIndex> | null
  isDeleted(origIdx: number): boolean
  /** Original page number → scroll to that page; returns false if the page was deleted */
  gotoPage(origPage: number): boolean
  addMarkup(type: MarkupType, origIdx: number, rects: [number, number, number, number][]): void
  formEdits(): ReadonlyMap<string, FormValueInput>
  applyFormEdit(v: FormValueInput): void
  rotatePage(origIdx: number, dir: 90 | -90): void
  deletePage(origIdx: number): boolean
  /** Page geometry (unrotated size + display rotation), for tools that place things by coordinates */
  pageGeom(origIdx: number): PageGeom
  /** Upsert one additive text/image edit (whiteout patch + replacement bitmap) */
  applyContentEdit(edit: PageContentEdit): void
  /** Sticky note at PDF user-space `at`; defaults to the page's top-right corner */
  addNote(origIdx: number, contents: string, at?: [number, number]): void
  /** Merge into the pending document metadata, saved on the next save */
  setDocumentMetadata(meta: MetadataInput): void
  /** Write the outline to the file (flushes pending edits first); never throws */
  writeOutline(nodes: OutlineEditNode[]): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * Bookmark node schema, nested a few levels deep: recursive JSON Schema `$ref`s are not portable
 * across providers, and modeling only the first levels keeps the generated arguments sane.
 */
const outlineNodeSchema = (depth: number): Record<string, unknown> => ({
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Bookmark title' },
    page: { type: 'integer', description: 'Target page (1-based)' },
    ...(depth > 0
      ? {
          children: {
            type: 'array',
            description: 'Nested bookmarks',
            items: outlineNodeSchema(depth - 1),
          },
        }
      : {}),
  },
  required: ['title', 'page'],
})

export const PDF_TOOLS: AgentToolDef[] = [
  {
    name: 'read_pages',
    description:
      'Read the text content of a page range (with [Page N] markers). Read the relevant pages before answering questions; at most 10 pages per call, over-long output is truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'integer', description: 'Start page number (1-based)' },
        end: {
          type: 'integer',
          description: 'End page number (inclusive); if omitted, only the start page is read',
        },
      },
      required: ['start'],
    },
  },
  {
    name: 'search_text',
    description:
      'Search the full text for a string; returns the page number and a context excerpt for each hit. Prefer this when locating which page something is on.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'goto_page',
    description: 'Scroll the reading view to the given page so the user can see it.',
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'integer', description: 'Page number (1-based)' } },
      required: ['page'],
    },
  },
  {
    name: 'get_outline',
    description:
      'Read the document outline (bookmarks) tree, including entry titles. Returns empty if the document has no outline.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_form_fields',
    description:
      'List the form fields with their kind and current value. Call this before fill_form_field to discover names and kinds.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fill_form_field',
    description:
      'Fill one form field by name. For checkboxes pass "true" or "false"; for radio/choice fields the option value must match. Field lookups come from list_form_fields.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Field name from list_form_fields' },
        value: { type: 'string', description: 'New value; checkbox accepts "true"/"false"' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'rotate_page',
    description:
      'Rotate one page a quarter turn. The change shows in the view immediately and is undoable by the user.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Page number (1-based)' },
        direction: {
          type: 'string',
          enum: ['cw', 'ccw'],
          description: 'Direction; clockwise by default',
        },
      },
      required: ['page'],
    },
  },
  {
    name: 'delete_page',
    description:
      'Remove one page from the document. Destructive but undoable; confirm with the user when the request is ambiguous.',
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'integer', description: 'Page number (1-based)' } },
      required: ['page'],
    },
  },
  {
    name: 'markup_text',
    description:
      'Highlight, underline or strike out every occurrence of a query, appended as real annotations (undoable). Prefer searching first; cap of 50 matches per call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to mark' },
        type: {
          type: 'string',
          enum: ['highlight', 'underline', 'strikeout', 'squiggly'],
          description: 'Markup kind; highlight by default',
        },
        page: {
          type: 'integer',
          description: 'Restrict to one page (1-based); omitted marks every page',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_note',
    description:
      'Add a sticky-note comment (a popup note annotation) on a page; undoable by the user. Positions are PDF points from the bottom-left corner; omit them to anchor the note at the page top-right.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Page number (1-based)' },
        text: { type: 'string', description: 'Note text' },
        x: { type: 'number', description: 'Optional x position in PDF points' },
        y: { type: 'number', description: 'Optional y position in PDF points' },
      },
      required: ['page', 'text'],
    },
  },
  {
    name: 'edit_text_block',
    description:
      'Replace one line of text on a page. "find" is matched case-insensitively against the page text lines; the original line is covered and the replacement added, so the page content stream is never rewritten. Read the page first to copy a distinctive part of the line.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: 'Page number (1-based)' },
        find: {
          type: 'string',
          description:
            'Text of the line to replace (case-insensitive; a distinctive substring is enough)',
        },
        replace: { type: 'string', description: 'Replacement text for the whole line' },
      },
      required: ['page', 'find', 'replace'],
    },
  },
  {
    name: 'set_outline',
    description:
      'Replace the document outline (bookmarks) with the given tree, written to the file after saving pending edits. Pages are 1-based; at most 500 entries, 8 levels deep. Use it to generate a table of contents once the pages are known.',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: 'Top-level bookmarks',
          items: outlineNodeSchema(2),
        },
      },
      required: ['nodes'],
    },
  },
  {
    name: 'word_count',
    description:
      'Count the words, characters and pages of the document text. Use this for statistics questions instead of pasting the whole text.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_metadata',
    description:
      'Read the document metadata: title, author, subject, keywords, creator, producer and the creation/modification dates.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_metadata',
    description:
      'Update the document metadata (title, author, subject, keywords). Provide at least one field; the change is saved with the document and is undoable by the user.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title' },
        author: { type: 'string', description: 'Author' },
        subject: { type: 'string', description: 'Subject' },
        keywords: { type: 'string', description: 'Keywords, comma-separated' },
      },
    },
  },
]

/** The slice of the preload bridge the web tools need (injectable so tests stay window-free) */
export interface WebToolBridge {
  webSearch(query: string, maxResults?: number): Promise<WebSearchResponse>
  webFetch(url: string): Promise<WebFetchResult>
}

/** Default search depth; the model may ask for fewer */
const DEFAULT_SEARCH_RESULTS = 6

export async function executeWebTool(
  call: AgentToolCall,
  bridge: WebToolBridge = window.pdfApi,
): Promise<ToolExecution> {
  switch (call.name) {
    case 'web_search': {
      const query = String(call.input.query ?? '').trim()
      if (!query) return err('query must not be empty', 'Web search')
      const maxResults = Number(call.input.maxResults) || DEFAULT_SEARCH_RESULTS
      const r = await bridge.webSearch(query, maxResults)
      // a backend failure must not read as "no results" — the model would fabricate conclusions
      if (r.method === 'error') {
        return err(
          `web search failed (service error, not an empty result — you may retry): ${r.error ?? 'unknown error'}`,
          'Web search failed',
        )
      }
      return {
        output: formatSearchResults(r.results, r.answer),
        summary: `Searched the web for "${query}" (${r.results.length} results)`,
        display: { kind: 'links', items: searchResultLinks(r.results) },
      }
    }
    case 'web_fetch': {
      const url = String(call.input.url ?? '').trim()
      if (!url) return err('url must not be empty', 'Web fetch')
      const r = await bridge.webFetch(url)
      if (r.isError || !r.content) {
        return err(`web fetch failed (service error; you may retry): ${url}`, 'Web fetch failed')
      }
      return {
        // Fetched page text is data, never instructions: the delimiters make that explicit to the model
        output: `Title: ${r.title}\nURL: ${r.url}\n\nBEGIN_UNTRUSTED_WEB_CONTENT\n${r.content}\nEND_UNTRUSTED_WEB_CONTENT`,
        summary: `Fetched ${r.title || r.url}`,
        display: { kind: 'links', items: [{ url: r.url, title: r.title }] },
      }
    }
    default:
      return err(`Unknown tool: ${call.name}`, call.name)
  }
}

function err(output: string, summary: string): ToolExecution {
  return { output, isError: true, summary }
}

/** Widget annotations from every page, for the form tools */
interface FieldEntry {
  name: string
  kind: FormValueInput['kind']
  widget: WidgetAnnotation
  /** 1-based orig page number the field's widget sits on */
  origPage: number
}

const kindOf = (w: WidgetAnnotation): FormValueInput['kind'] =>
  w.radioButton ? 'radio' : w.checkBox ? 'checkbox' : Array.isArray(w.options) ? 'choice' : 'text'

async function collectFields(deps: PdfSkillDeps): Promise<FieldEntry[]> {
  const d = deps.doc()
  if (!d) return []
  const out: FieldEntry[] = []
  for (let n = 1; n <= d.numPages; n++) {
    const page = await d.getPage(n)
    const annotations = await page.getAnnotations()
    // SAFETY: pdfjs ships widget fields (fieldName/fieldValue/checkBox/radioButton/options) untyped
    // in its annotation data; the doc is ours to walk, so the fields convey invariant meaning
    const annotations_ = annotations as unknown as (WidgetAnnotation & {
      annotationType?: number
    })[]
    for (const a of annotations_) {
      if (a.annotationType !== WIDGET || typeof a.fieldName !== 'string' || !a.fieldName) continue
      out.push({ name: a.fieldName, kind: kindOf(a), widget: a, origPage: n })
    }
    page.cleanup()
  }
  return out
}

async function listFormFields(deps: PdfSkillDeps): Promise<ToolExecution> {
  const fields = await collectFields(deps)
  const lines = fields.map((f) => {
    const value = f.widget.fieldValue
    const shown = f.kind === 'checkbox' ? String(value === true) : String(value ?? '')
    return `- ${f.name} (${f.kind}) = "${shown}"${f.widget.readOnly ? ' [read-only]' : ''}`
  })
  return {
    output: lines.join('\n') || 'The document has no form fields',
    summary: t('aiToolFields', { count: fields.length }),
  }
}

const CHECKBOX_ALIASES = new Set(['true', 'yes', 'checked', 'an', '1', '✓'])

async function fillFormField(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const name = String(input.name ?? '').trim()
  const raw = input.value === undefined ? '' : String(input.value)
  const summary = t('aiToolFill', { name })
  if (!name) return err('name must not be empty', summary)

  const fields = await collectFields(deps)
  const field = fields.find((f) => f.name === name)
  if (!field) {
    const known = fields.map((f) => f.name).join(', ')
    return err(
      known
        ? `Unknown field "${name}" (fields: ${known})`
        : `Unknown field "${name}" (the document has no form fields)`,
      summary,
    )
  }
  if (field.widget.readOnly) return err(`Field "${name}" is read-only`, summary)

  const kind = field.kind
  if (kind === 'checkbox') {
    const checked = CHECKBOX_ALIASES.has(raw.toLowerCase())
    deps.applyFormEdit({ name, kind, checked })
    return { output: `Checked "${name}"`, summary, mutated: true }
  }
  if (raw === '') return err(`Empty value for "${name}"`, summary)
  if (kind === 'radio' || kind === 'choice') {
    const options = (field.widget.options ?? []).map((o) => String(o.exportValue))
    if (options.length > 0 && !options.includes(raw)) {
      return err(
        `"${raw}" is not one of the options for "${name}" (options: ${options.join(', ')})`,
        summary,
      )
    }
    deps.applyFormEdit({ name, kind, value: raw })
    return { output: `Set "${name}" to "${raw}"`, summary, mutated: true }
  }
  deps.applyFormEdit({ name, kind: 'text', value: raw })
  return { output: `Set "${name}" to "${raw}"`, summary, mutated: true }
}

/** Validate a 1-based page number; returns the original page index or an error */
function resolvePage(deps: PdfSkillDeps, raw: unknown): { origIdx: number } | { bad: string } {
  const page = Number(raw)
  if (!Number.isInteger(page) || page < 1 || page > deps.pageCount()) {
    return {
      bad: `Page number ${String(raw)} is out of range (document has ${deps.pageCount()} pages)`,
    }
  }
  if (deps.isDeleted(page - 1)) return { bad: `Page ${page} has been deleted (unsaved)` }
  return { origIdx: page - 1 }
}

async function readPages(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const doc = deps.doc()
  if (!doc) return err('Document not ready', t('aiToolReadPages', { start: '?', end: '?' }))
  const start = Number(input.start)
  const end = Math.min(Number(input.end ?? start), start + 9)
  const summary = t('aiToolReadPages', { start, end })
  if (!Number.isInteger(start) || start < 1 || end < start || start > doc.numPages) {
    return err(`Invalid page range (document has ${doc.numPages} pages)`, summary)
  }
  let out = ''
  for (let n = start; n <= Math.min(end, doc.numPages); n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    let text = ''
    for (const item of content.items) {
      if ('str' in item) {
        text += item.str
        if (item.hasEOL) text += '\n'
      }
    }
    page.cleanup()
    out += `[Page ${n}]\n${text.trim()}\n\n`
    if (out.length > READ_CHUNK_CHARS) {
      out = `${out.slice(0, READ_CHUNK_CHARS)}\n… (truncated; read the rest in further calls)`
      break
    }
  }
  return {
    output: out.trim() || '(No extractable text in this range; the pages may be scanned images)',
    summary,
  }
}

async function searchText(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const query = String(input.query ?? '').trim()
  if (!query) return err('query must not be empty', t('aiToolSearch', { query: '', count: 0 }))
  const indexPromise = deps.searchIndex()
  if (!indexPromise) return err('Document not ready', t('aiToolSearch', { query, count: 0 }))
  const index = await indexPromise
  const matches = searchInIndex(index, query)
  const lines: string[] = []
  for (const m of matches.slice(0, MAX_MATCHES)) {
    const entry = index[m.pageIndex]!
    const pos = entry.lower.indexOf(query.toLowerCase())
    const from = Math.max(0, pos - 40)
    const snippet = entry.text.slice(from, pos + query.length + 40).replace(/\s+/g, ' ')
    lines.push(`Page ${m.pageIndex + 1}: …${snippet}…`)
  }
  if (matches.length > MAX_MATCHES)
    lines.push(`(${matches.length} matches total; only the first ${MAX_MATCHES} listed)`)
  return {
    output: lines.join('\n') || 'No matches found',
    summary: t('aiToolSearch', { query, count: matches.length }),
  }
}

/** Password-protected (or otherwise read-only) documents refuse every write */
function guardWrite(deps: PdfSkillDeps): ToolExecution | null {
  if (deps.readOnly()) {
    return err(
      'The document is password-protected; changes are disabled in this session',
      'Read-only document',
    )
  }
  return null
}

async function rotatePage(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const page = Number(input.page)
  const summary = t('aiToolRotate', { page })
  const r = resolvePage(deps, input.page)
  if ('bad' in r) return err(r.bad, summary)
  const dir = input.direction === 'ccw' ? -90 : 90
  deps.rotatePage(r.origIdx, dir)
  return {
    output: `Rotated page ${page} ${dir === 90 ? 'clockwise' : 'counter-clockwise'}`,
    summary,
    mutated: true,
  }
}

async function deletePageTool(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const page = Number(input.page)
  const summary = t('aiToolDelete', { page })
  const r = resolvePage(deps, input.page)
  if ('bad' in r) return err(r.bad, summary)
  if (!deps.deletePage(r.origIdx)) {
    return err('Deleting every page is not allowed — one page has to remain', summary)
  }
  return { output: `Removed page ${page}`, summary, mutated: true }
}

async function markupText(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const query = String(input.query ?? '').trim()
  const pageFilter = Number(input.page)
  // Absent type means the schema default; only an explicit unknown kind is rejected
  const type = (typeof input.type === 'string' ? input.type : 'highlight') as MarkupType
  const valid = ['highlight', 'underline', 'strikeout', 'squiggly'].includes(type)
  if (!query) return err('query must not be empty', t('aiToolMarkup', { page: '?' }))

  const indexPromise = deps.searchIndex()
  if (!indexPromise) return err('Document not ready', t('aiToolMarkup', { page: '?' }))
  if (!valid) {
    return err(
      `type must be one of highlight, underline, strikeout, squiggly (got "${String(input.type)}")`,
      t('aiToolMarkup', { page: pageFilter || '?' }),
    )
  }
  const index = await indexPromise

  let matches = searchInIndex(index, query)
  if (Number.isInteger(pageFilter)) matches = matches.filter((m) => m.pageIndex === pageFilter - 1)
  if (matches.length === 0) {
    return err(
      t('aiToolSearch', { query, count: 0 }),
      t('aiToolMarkup', { page: pageFilter || '?' }),
    )
  }

  const capped = matches.slice(0, MAX_MARKUPS)
  const byPage = new Map<number, [number, number, number, number][]>()
  for (const m of capped) {
    for (const rect of m.rects) {
      const list = byPage.get(m.pageIndex)
      if (list) list.push(rect)
      else byPage.set(m.pageIndex, [rect])
    }
  }
  for (const [pageIndex, rects] of byPage) deps.addMarkup(type, pageIndex, rects)

  const pages = [...byPage.keys()].map((p) => p + 1)
  const marks = capped.reduce((sum, m) => sum + m.rects.length, 0)
  const lines = pages.map((p) => {
    const rects = byPage.get(p - 1)!.length
    return `Page ${p}: ${rects} marks (${type})`
  })
  if (matches.length > capped.length) {
    lines.push(`(${matches.length - capped.length} more matches were left unmarked)`)
  }
  lines.push(`(${marks} marks added across ${pages.length} page${pages.length === 1 ? '' : 's'})`)
  return {
    output: lines.join('\n'),
    summary: t('aiToolMarkup', { page: pages[0]! }),
    mutated: true,
  }
}

/** Notes, text replacements, outlines and metadata: the additive write tools */
async function addNoteTool(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const page = Number(input.page)
  const summary = t('aiToolNote', { page })
  const r = resolvePage(deps, input.page)
  if ('bad' in r) return err(r.bad, summary)
  const text = String(input.text ?? '').trim()
  if (!text) return err('text must not be empty', summary)
  const geom = deps.pageGeom(r.origIdx)
  const x = Number(input.x)
  const y = Number(input.y)
  const at: [number, number] =
    input.x !== undefined && input.y !== undefined && Number.isFinite(x) && Number.isFinite(y)
      ? [x, y]
      : [geom.pw - 48, geom.ph - 48]
  deps.addNote(r.origIdx, text, at)
  return { output: `Note added on page ${page}`, summary, mutated: true }
}

/** Resolved text line plus the model's replacement → one additive content edit */
async function editTextBlock(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const doc = deps.doc()
  const page = Number(input.page)
  const summary = t('aiToolEditText', { page })
  if (!doc) return err('Document not ready', summary)
  const r = resolvePage(deps, input.page)
  if ('bad' in r) return err(r.bad, summary)
  const find = String(input.find ?? '').trim()
  const replace = input.replace === undefined ? '' : String(input.replace)
  if (!find) return err('find must not be empty', summary)
  if (!replace.trim()) return err('replace must not be empty', summary)

  const geom = deps.pageGeom(r.origIdx)
  const pdfPage = await doc.getPage(r.origIdx + 1)
  const content = await pdfPage.getTextContent()
  const blocks = extractPageTextBlocks(r.origIdx, content.items, content.styles)
  // Matching a substring of the line is what the model can reliably quote from read_pages
  const needle = find.toLowerCase()
  const block = blocks.find((b) => b.text.toLowerCase().includes(needle))
  if (!block) {
    const lines = blocks.map((b) => b.text.trim()).filter((line) => line !== '')
    pdfPage.cleanup()
    if (lines.length === 0) {
      return err(`Page ${page} has no extractable text (it may be a scanned image)`, summary)
    }
    const listed = lines.slice(0, MAX_LISTED_LINES).map((line) => `- ${line}`)
    if (lines.length > listed.length) listed.push(`… (${lines.length} lines in total)`)
    return err(
      `No text line on page ${page} contains "${find}". Lines on that page:\n${listed.join('\n')}`,
      summary,
    )
  }

  // An offscreen render at scale 1, only to sample the page's own colors for the replacement;
  // without it buildTextEdit falls back to a white page and dark ink.
  let canvas: HTMLCanvasElement | null = null
  try {
    const viewport = pdfPage.getViewport({ scale: 1, rotation: geom.rot })
    const offscreen = document.createElement('canvas')
    offscreen.width = Math.max(1, Math.floor(viewport.width))
    offscreen.height = Math.max(1, Math.floor(viewport.height))
    await pdfPage.render({ canvas: offscreen, viewport }).promise
    canvas = offscreen
  } catch {
    // A page pdf.js cannot render still gets the edit: colors fall back to white page / dark ink
  } finally {
    pdfPage.cleanup()
  }

  const edit = buildTextEdit(geom, block, canvas, replace, { scale: 1 })
  if (!edit) return err('The replacement text rendered to nothing', summary)
  deps.applyContentEdit(edit)
  return {
    output: `Page ${page}: replaced "${block.text}" with "${replace}"`,
    summary,
    mutated: true,
  }
}

interface RawOutlineNode {
  title?: unknown
  page?: unknown
  children?: unknown
}

/**
 * Validate a model-supplied outline tree and turn its 1-based pages into page indices. Returns an
 * error string instead of throwing so the model gets a correction it can act on.
 */
function convertOutline(
  deps: PdfSkillDeps,
  raw: unknown,
  depth: number,
  count: { n: number },
): OutlineEditNode[] | string {
  if (!Array.isArray(raw)) return 'nodes must be an array of bookmarks'
  // Only the root list has to carry entries: `children: []` is how a model spells "no children"
  if (depth === 1 && raw.length === 0) return 'nodes must not be empty'
  if (depth > MAX_OUTLINE_DEPTH) return `The outline is deeper than ${MAX_OUTLINE_DEPTH} levels`
  const out: OutlineEditNode[] = []
  for (const entry of raw) {
    // SAFETY: model arguments are untyped JSON; every field is validated before it is used
    const node = entry as RawOutlineNode
    const title = typeof node.title === 'string' ? node.title.trim() : ''
    if (!title) return 'Every bookmark needs a non-empty title'
    const r = resolvePage(deps, node.page)
    if ('bad' in r) return `"${title}": ${r.bad}`
    count.n += 1
    if (count.n > MAX_OUTLINE_NODES) {
      return `The outline has more than ${MAX_OUTLINE_NODES} entries`
    }
    const children =
      node.children === undefined ? [] : convertOutline(deps, node.children, depth + 1, count)
    if (typeof children === 'string') return children
    out.push({ title, pageIndex: r.origIdx, ...(children.length > 0 ? { children } : {}) })
  }
  return out
}

/**
 * Rebase an AI outline's page indices onto the numbering the saved file will use.
 *
 * `set_outline` flushes pending edits first, and that save applies the pending page deletes and
 * reorder — i.e. the file is renumbered while the nodes still carry original document indices.
 * `fileOrder` is the display order the save will write (original indices, visible pages only), so
 * each node lands on the position its page will occupy on disk. Returns an error string instead of
 * dropping entries, so a stale index can never silently point at a different page.
 */
export function remapOutlinePages(
  nodes: OutlineEditNode[],
  fileOrder: number[],
): OutlineEditNode[] | string {
  const out: OutlineEditNode[] = []
  for (const node of nodes) {
    const children = remapOutlinePages(node.children ?? [], fileOrder)
    if (typeof children === 'string') return children
    // URI bookmarks carry no destination; their pageIndex is ignored by the writer
    const pageIndex = node.uri ? node.pageIndex : fileOrder.indexOf(node.pageIndex)
    if (!node.uri && pageIndex < 0) {
      return `Page ${node.pageIndex + 1} of "${node.title}" is not in the saved document`
    }
    out.push({ ...node, pageIndex, ...(children.length > 0 ? { children } : {}) })
  }
  return out
}

async function setOutlineTool(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const count = { n: 0 }
  const nodes = convertOutline(deps, input.nodes, 1, count)
  if (typeof nodes === 'string') return err(nodes, t('aiToolOutlineSet', { count: 0 }))
  const summary = t('aiToolOutlineSet', { count: count.n })
  const result = await deps.writeOutline(nodes)
  if (!result.ok) return err(result.error, summary)
  return { output: `Wrote ${count.n} outline entries`, summary, mutated: true }
}

async function wordCount(deps: PdfSkillDeps): Promise<ToolExecution> {
  const indexPromise = deps.searchIndex()
  if (!indexPromise) return err('Document not ready', t('aiToolWordCount', { count: 0 }))
  const index = await indexPromise
  let words = 0
  let characters = 0
  for (const entry of index) {
    words += entry.text.trim().split(/\s+/).filter(Boolean).length
    // Whitespace does not count: the number readers expect is non-space characters
    characters += entry.text.replace(/\s/g, '').length
  }
  return {
    output: `Words: ${words}, characters: ${characters}, pages: ${index.length}`,
    summary: t('aiToolWordCount', { count: words }),
  }
}

/** `info` from pdf.js is untyped; absent or blank fields read as (not set) */
const infoField = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '(not set)'

async function getMetadata(deps: PdfSkillDeps): Promise<ToolExecution> {
  const doc = deps.doc()
  const summary = t('aiToolMetadata')
  if (!doc) return err('Document not ready', summary)
  try {
    const { info } = await doc.getMetadata()
    const raw = (info ?? {}) as Record<string, unknown>
    const fields: [string, unknown][] = [
      ['Title', raw.Title],
      ['Author', raw.Author],
      ['Subject', raw.Subject],
      ['Keywords', raw.Keywords],
      ['Creator', raw.Creator],
      ['Producer', raw.Producer],
      ['Created', raw.CreationDate],
      ['Modified', raw.ModDate],
    ]
    return {
      output: fields.map(([label, value]) => `${label}: ${infoField(value)}`).join('\n'),
      summary,
    }
  } catch (e) {
    return err(
      `Could not read the metadata: ${e instanceof Error ? e.message : String(e)}`,
      summary,
    )
  }
}

async function setMetadataTool(
  deps: PdfSkillDeps,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const summary = t('aiToolMetadataSet')
  const meta: MetadataInput = {}
  const changed: string[] = []
  for (const key of ['title', 'author', 'subject', 'keywords'] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'string') return err(`${key} must be a string`, summary)
    meta[key] = value.trim()
    changed.push(key)
  }
  if (changed.length === 0) {
    return err('Provide at least one of title, author, subject, keywords', summary)
  }
  deps.setDocumentMetadata(meta)
  return { output: `Updated metadata: ${changed.join(', ')}`, summary, mutated: true }
}

export async function executePdfTool(
  deps: PdfSkillDeps,
  call: AgentToolCall,
): Promise<ToolExecution> {
  const mutating = [
    'fill_form_field',
    'rotate_page',
    'delete_page',
    'markup_text',
    'add_note',
    'edit_text_block',
    'set_metadata',
  ].includes(call.name)
  const release = mutating && deps.beginEdit ? deps.beginEdit() : undefined
  if (release === null) return err('A file operation is in progress. Please retry.', call.name)
  try {
    return await executePdfToolInner(deps, call)
  } finally {
    release?.()
  }
}

async function executePdfToolInner(
  deps: PdfSkillDeps,
  call: AgentToolCall,
): Promise<ToolExecution> {
  const input = call.input
  switch (call.name) {
    case 'read_pages':
      return readPages(deps, input)
    case 'search_text':
      return searchText(deps, input)
    case 'goto_page': {
      const summary = t('aiToolGoto', { page: Number(input.page) })
      const r = resolvePage(deps, input.page)
      if ('bad' in r) return err(r.bad, summary)
      deps.gotoPage(r.origIdx + 1)
      return { output: `Jumped to page ${r.origIdx + 1}`, summary }
    }
    case 'list_form_fields':
      return listFormFields(deps)
    case 'fill_form_field': {
      const denied = guardWrite(deps)
      if (denied) return denied
      return fillFormField(deps, input)
    }
    case 'rotate_page': {
      const denied = guardWrite(deps)
      if (denied) return denied
      return rotatePage(deps, input)
    }
    case 'delete_page': {
      const denied = guardWrite(deps)
      if (denied) return denied
      return deletePageTool(deps, input)
    }
    case 'markup_text': {
      const denied = guardWrite(deps)
      if (denied) return denied
      return markupText(deps, input)
    }
    case 'add_note': {
      const denied = guardWrite(deps)
      if (denied) return denied
      return addNoteTool(deps, input)
    }
    case 'edit_text_block': {
      const denied = guardWrite(deps)
      if (denied) return denied
      return editTextBlock(deps, input)
    }
    case 'set_outline': {
      const denied = guardWrite(deps)
      if (denied) return denied
      return setOutlineTool(deps, input)
    }
    case 'word_count':
      return wordCount(deps)
    case 'get_metadata':
      return getMetadata(deps)
    case 'set_metadata': {
      const denied = guardWrite(deps)
      if (denied) return denied
      return setMetadataTool(deps, input)
    }
    case 'get_outline': {
      const outline = deps.outline()
      const lines: string[] = []
      const walk = (nodes: OutlineNode[], depth: number) => {
        for (const n of nodes) {
          lines.push(`${'  '.repeat(depth)}${n.title}`)
          if (n.items) walk(n.items, depth + 1)
        }
      }
      if (outline) walk(outline, 0)
      return {
        output: lines.join('\n') || 'The document has no outline',
        summary: t('aiToolOutline'),
      }
    }
    default:
      return err(`Unknown tool: ${call.name}`, call.name)
  }
}
