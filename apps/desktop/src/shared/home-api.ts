import type { Lang } from '@arareader/i18n'
import type { AppUpdateState, ChangelogEntry } from './update-api'

/** UI language; the persisted value is a supported @arareader/i18n Lang */
export type UiLanguage = Lang

/** UI theme preference */
export type UiTheme = 'light' | 'dark' | 'system'

/** a recent PDF shown on the home screen */
export interface RecentEntry {
  path: string
  name: string
  /** lowercased extension without the dot ('pdf' in the PDF-only host) */
  ext: string
  /** last-modified time, ms since epoch */
  mtimeMs: number
  /** file size in bytes */
  sizeBytes: number
}

/** paged query for the home recent list */
export interface RecentQuery {
  /** number of entries to skip (default 0) */
  offset?: number
  /** page size; 0 returns no entries but still reports totals (default 50) */
  limit?: number
}

export interface RecentPage {
  entries: RecentEntry[]
  /** total matching the query (files missing from disk are skipped) */
  total: number
  /** total ignoring paging (for the home counters) */
  totalAll: number
}

/** outcome of the New PDF flow: written + opened, canceled, or a write error */
export type NewPdfResult =
  { ok: true; path: string } | { ok: true; canceled: true } | { ok: false; error: string }

/** User profile & signer credentials persisted in userData/app-settings.json */
export interface UserProfile {
  displayName: string
  fullName: string
  title: string
  organization: string
  email: string
  useAsDefaultAuthor: boolean
}

/** A reusable e-signature or initials stamp saved in the user's E-Sign Vault */
export interface SavedSignature {
  id: string
  label: string
  kind: 'strokes' | 'image'
  /** Stroke paths when kind === 'strokes' */
  paths?: number[][]
  /** Base64 PNG (without data: prefix) when kind === 'image' */
  image?: string
  width: number
  height: number
  /** Normalized RGB [0..1] for stroke signatures */
  color?: [number, number, number]
  createdAt: number
  isDefault?: boolean
}

/** Host & reader preferences persisted in userData/app-settings.json */
export interface ReaderPreferences {
  profile: UserProfile
  signatures: SavedSignature[]
  starredPaths: string[]
  defaultZoom: 'fit-width' | 'fit-page' | '100' | '125'
  defaultSidebar: 'none' | 'thumbs' | 'outline'
  autosave: boolean
  /** Auto-gather document context on first open to generate AI-tailored recommendations */
  aiAutoSuggestions?: boolean
  /** Whether the user has seen or completed the initial onboarding modal */
  onboardingCompleted?: boolean
}

export interface HomeApi {
  /** recent PDFs, newest first (paged) */
  recents(query?: RecentQuery): Promise<RecentPage>
  /** open an existing PDF path in a tab */
  openPath(path: string): Promise<void>
  /** show the PDF file picker, then open the chosen file in a tab */
  openPdf(): Promise<void>
  /** Save-As a blank one-page PDF, then open it in a tab */
  newPdf(): Promise<NewPdfResult>
  /** show the PDF file picker (the home Browse affordance) */
  browse(): Promise<void>
  /** drop entries from the recent list (does not touch the files) */
  removeRecent(paths: string[]): Promise<void>
  /** reveal the file in Finder / Explorer */
  revealPath(path: string): Promise<void>
  /** current UI language (persisted in userData/app-settings.json) */
  getLanguage(): Promise<UiLanguage>
  /** switch + persist the UI language; the host notifies every renderer */
  setLanguage(lang: UiLanguage): Promise<void>
  /** current UI theme preference (persisted in userData/app-settings.json) */
  getTheme(): Promise<UiTheme>
  /** switch + persist the UI theme */
  setTheme(theme: UiTheme): Promise<void>
  /** read user profile, saved e-signatures, starred files, and reader defaults */
  getPreferences(): Promise<ReaderPreferences>
  /** persist updated user preferences and broadcast to all views */
  setPreferences(prefs: ReaderPreferences): Promise<ReaderPreferences>
  /** subscribe to preference updates from any view */
  onPreferencesChanged(handler: (prefs: ReaderPreferences) => void): () => void
  /** app version (from package.json / app.getVersion) */
  getAppVersion(): Promise<string>
  /** current update state (status, version, download percent) */
  getUpdateState(): Promise<AppUpdateState>
  /** trigger a manual check for updates */
  checkForUpdates(): Promise<void>
  /** restart the app and install the downloaded update */
  restartAndInstall(): Promise<void>
  /** release history for the changelog modal */
  getChangelog(): Promise<ChangelogEntry[]>
  /** whether this launch follows an update (first-run changelog popup) */
  getJustUpdated(): Promise<boolean>
  /** clear the just-updated flag once the changelog has been shown */
  clearJustUpdated(): Promise<void>
  /** listen to update state broadcasts from main */
  onUpdateStateChanged(handler: (state: AppUpdateState) => void): () => void
}

export const HOME_CHANNELS = {
  recents: 'home:recents',
  openPath: 'home:open-path',
  openPdf: 'home:open-pdf',
  newPdf: 'home:new-pdf',
  browse: 'home:browse',
  removeRecent: 'home:remove-recent',
  revealPath: 'home:reveal-path',
  getLanguage: 'home:get-language',
  setLanguage: 'home:set-language',
  getTheme: 'home:get-theme',
  setTheme: 'home:set-theme',
  getPreferences: 'home:get-preferences',
  setPreferences: 'home:set-preferences',
  preferencesChanged: 'home:preferences-changed',
  getAppVersion: 'home:get-app-version',
  getUpdateState: 'home:get-update-state',
  checkForUpdates: 'home:check-for-updates',
  restartAndInstall: 'home:restart-and-install',
  getChangelog: 'home:get-changelog',
  getJustUpdated: 'home:get-just-updated',
  clearJustUpdated: 'home:clear-just-updated',
  updateStateChanged: 'home:update-state-changed',
} as const
