import {
  buildAppSystemPrompt,
  composeSkills,
  SEARCH_PROMPT,
  WEB_SEARCH_TOOLS,
  type AgentSkill,
  type AgentToolDef,
} from '@arareader/agent-core'
import systemSection from './prompts/system.md?raw'
import { PDF_TOOLS, executePdfTool, executeWebTool } from './tools'
import type { PdfSkillDeps } from './tools'
import { createFilesSkill } from './files-skill'
import type { AttachmentMeta } from '../../shared/ipc'

const SYSTEM_PROMPT = buildAppSystemPrompt(systemSection)

/** Web search/fetch as a skill: the shared tool shapes, executed through the preload bridge */
function createWebSkill(): AgentSkill {
  const tools: AgentToolDef[] = WEB_SEARCH_TOOLS.map((tool) => ({ ...tool }))
  return {
    id: 'web',
    systemPrompt: SEARCH_PROMPT,
    tools,
    executeTool: (call) => executeWebTool(call),
  }
}

/**
 * The PDF copilot: document tools (read/search/navigate/mark up), local
 * attachments (read_attachment) and web search/fetch, merged into one skill.
 * Tool names are globally unique across the three (composeSkills throws on dupes).
 */
export function createPdfSkill(
  deps: PdfSkillDeps,
  getAttachments: () => AttachmentMeta[],
): AgentSkill {
  const pdfSkill: AgentSkill = {
    id: 'pdf',
    systemPrompt: SYSTEM_PROMPT,
    tools: PDF_TOOLS,
    buildContext: () => {
      const parts = [
        `Current document: "${deps.fileName()}", ${deps.pageCount()} pages; the user is viewing page ${deps.currentPage()}.`,
        'Mode: the document can be edited from this chat (annotations, form fills, page operations); password-protected files stay read-only.',
      ]
      const outline = deps.outline()
      if (outline && outline.length > 0) {
        parts.push(
          `The document has an outline (${outline.length} top-level entries); use get_outline to view it.`,
        )
      }
      return parts.join('\n')
    },
    executeTool: (call) => executePdfTool(deps, call),
  }
  return composeSkills('pdf+files+web', '', [
    pdfSkill,
    createFilesSkill(getAttachments),
    createWebSkill(),
  ])
}
