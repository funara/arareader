import { describe, expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { createPdfSkill } from '../src/renderer/ai/pdf-skill'
import { buildContextualFirstSuggestion, parseAiSuggestions } from '../src/renderer/ai/AiPanel'
import type { PdfSkillDeps } from '../src/renderer/ai/tools'

/**
 * The composed PDF copilot skill: PDF document tools + local attachments +
 * web search/fetch. No `window` involved — creating the skill must not touch
 * the preload bridge (executors reach it lazily, only when a tool runs).
 */
function stubDeps(): PdfSkillDeps {
  const doc = { numPages: 1 } as unknown as PDFDocumentProxy
  return {
    doc: () => doc,
    fileName: () => 'stub.pdf',
    pageCount: () => 1,
    currentPage: () => 1,
    readOnly: () => false,
    outline: () => null,
    searchIndex: () => null,
    isDeleted: () => false,
    gotoPage: () => true,
    addMarkup: () => {},
    formEdits: () => new Map(),
    applyFormEdit: () => {},
    rotatePage: () => {},
    deletePage: () => false,
    pageGeom: () => ({ pw: 612, ph: 792, rot: 0 }),
    applyContentEdit: () => {},
    addNote: () => {},
    setDocumentMetadata: () => {},
    writeOutline: async () => ({ ok: true as const }),
  }
}

describe('createPdfSkill', () => {
  const skill = createPdfSkill(stubDeps(), () => [])
  const names = skill.tools.map((tool) => tool.name)

  it('keeps the PDF document tools', () => {
    expect(names).toContain('read_pages')
    expect(names).toContain('search_text')
    expect(names).toContain('goto_page')
    expect(names).toContain('markup_text')
    expect(names).toContain('fill_form_field')
  })

  it('exposes the shared attachment and web tools', () => {
    expect(names).toContain('read_attachment')
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
  })

  it('has globally unique tool names', () => {
    expect(new Set(names).size).toBe(names.length)
  })

  it('composes the PDF, attachments and web prompt sections', () => {
    expect(skill.systemPrompt).toContain('Attachments')
    expect(skill.systemPrompt).toContain('Web search')
    // the PDF domain rules survive composition
    expect(skill.systemPrompt).toContain('read_pages')
    expect(skill.systemPrompt.toLowerCase()).toContain('untrusted')
  })

  it('does not list attachments when there are none', () => {
    expect(skill.buildContext?.() ?? '').not.toContain('Attachment list')
  })

  it('is composed from one skill id', () => {
    expect(skill.id).toBe('pdf+files+web')
  })

  it('refuses a tool no sub-skill owns', async () => {
    const result = await skill.executeTool({ id: 't1', name: 'not_a_tool', input: {} })
    expect(result.isError).toBe(true)
  })
})

describe('adaptive AI suggestions', () => {
  it('parses JSON array, single object, and wrapped suggestions with flexible keys', () => {
    const arr = parseAiSuggestions(
      '```json\n[{"title": "Summarize Contract", "subtitle": "Key clauses & obligations", "prompt": "Summarize the main obligations in this contract."}]\n```',
    )
    expect(arr).toHaveLength(1)
    expect(arr?.[0]?.title).toBe('Summarize Contract')

    const single = parseAiSuggestions(
      '{"label": "Review Methodology", "description": "Study design & sample", "question": "Explain the methodology section."}',
    )
    expect(single).toHaveLength(1)
    expect(single?.[0]?.title).toBe('Review Methodology')
    expect(single?.[0]?.subtitle).toBe('Study design & sample')
    expect(single?.[0]?.prompt).toBe('Explain the methodology section.')

    const wrapped = parseAiSuggestions(
      '{"suggestions": [{"title": "First", "prompt": "Q1"}, {"title": "Second", "prompt": "Q2"}]}',
    )
    expect(wrapped).toHaveLength(2)
  })

  it('builds a context-aware first suggestion from document outline and excerpt', () => {
    const item = buildContextualFirstSuggestion(
      'quarterly_report_2026.pdf',
      14,
      ['Executive Summary', 'Financial Highlights'],
      '--- Page 1 ---\nQ3 2026 Financial Performance',
    )
    expect(item.title).toContain('Executive Summary')
    expect(item.subtitle).toContain('14p')
    expect(item.prompt).toContain('quarterly_report_2026.pdf')
  })
})
