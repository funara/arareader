import { createFilesSkill as createSharedFilesSkill } from '@arareader/agent-core'
import type { AttachmentMeta } from '../../shared/ipc'
import { ATTACHMENT_IMAGE_EXTS } from '../../shared/ipc'

/**
 * Chat-attachment capability as an AgentSkill: the per-turn context lists the
 * attached local files, and read_attachment pages through their extracted text
 * (parsing happens in the main process; files never leave the machine).
 *
 * Labels are English here on purpose — the shared skill texts are new UI
 * strings the PDF string table does not carry yet.
 */
export function createFilesSkill(getAttachments: () => AttachmentMeta[]) {
  return createSharedFilesSkill({
    getAttachments,
    readAttachment: (path, offset, maxChars) =>
      window.pdfApi.readAttachment(path, offset, maxChars),
    isImageExt: (ext) => ATTACHMENT_IMAGE_EXTS.has(ext),
    texts: {
      unknownTool: (name) => `Unknown tool: ${name}`,
      invalidIndex: () => 'Invalid attachment index (see the attachment list)',
      invalidIndexSummary: () => 'Read attachment',
      imageOutput: (name) =>
        `${name} is an image attachment already sent as an image with the user message; just look at the image in the message, no text to read.`,
      imageSummary: (name) => `View image ${name}`,
      readFail: (name) => `Could not read ${name}`,
      readSummary: (name) => `Read ${name}`,
    },
  })
}
