import { createElectronTransport as createSharedTransport } from '@arareader/agent-core'
import type { AiSettings } from '@arareader/ai-provider'
import { t } from '../i18n/locale'

/** The shared IPC transport wired to the pdf preload bridge (window.pdfApi). */
export function createElectronTransport(getSettings: () => AiSettings) {
  return createSharedTransport({
    app: 'pdf',
    bridge: window.pdfApi,
    getSettings,
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
  })
}
