import type { HomeApi } from '../../shared/home-api'
import type { TabsApi } from '../../shared/tabs-api'
import type { WindowApi } from '../../shared/window-api'
import type { ReaderAiApi, ReaderProjectApi } from '../../shared/ai-api'

declare global {
  interface Window {
    reader: HomeApi
    readerTabs: TabsApi
    readerWindow: WindowApi
    /** AI provider settings + provider-setup request channel (redacted reads) */
    readerAi: ReaderAiApi
    /** per-document chat history (resolve/append/load/rebind) */
    readerProject: ReaderProjectApi
  }
}

export {}
