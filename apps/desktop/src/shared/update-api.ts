// Contracts between the host main-process auto-updater and the renderer
// surfaces: AppUpdateState / ChangelogEntry for Home, the changelog modal and
// the download-and-restart prompt.
export type UpdateStatus =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface AppUpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  percent?: number
  error?: string
  releaseNotes?: string
}

export interface ChangelogEntry {
  version: string
  title: string
  body: string
  publishedAt: string
  htmlUrl?: string
}
