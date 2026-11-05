/// <reference types="vite/client" />

import type { PdfApi, PdfProjectApi } from '../shared/ipc'

declare global {
  interface Window {
    pdfApi: PdfApi
    /** per-document chat history, exposed by the PDF preload (project-store backed) */
    pdfProject: PdfProjectApi
  }
}

export {}
