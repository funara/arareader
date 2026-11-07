import type { Lang, Params } from '@arareader/i18n'
import { format } from '@arareader/i18n'

/**
 * English defines the key set for the PDF host; M2 adds the remaining
 * translations. Until then every language falls back to English.
 */
const en = {
  home: 'Home',
  openPdf: 'Open PDF',
  newPdf: 'New PDF',
  newPdfFailed: 'Could not create the PDF: {error}',
  tagline: 'Smart PDF Reader & Editor',
  secRecent: 'Recent',
  fileCountOne: '1 file',
  fileCountMany: '{n} files',
  emptyRecent: 'No recent PDFs — open a PDF to get started.',
  colName: 'Name',
  colLocation: 'Location',
  colModified: 'Modified',
  colSize: 'Size',
  removeFromList: 'Remove from list',
  closeTab: 'Close tab',
  version: 'Version {v}',
  switchToLight: 'Switch to light mode',
  switchToDark: 'Switch to dark mode',
  exitReadMode: 'Exit Read mode',
  viewMode: 'View mode',
  continuousView: 'Continuous',
  pagedView: 'Page by page',
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',
  language: 'Language',
  about: 'About',
  author: 'by Adhi Rahmadian',
  aboutTitle: 'About ARAReader',
  versionLabel: 'Version',
  licenseLabel: 'License',
  repositoryLabel: 'Repository',
} as const

export type StringKey = keyof typeof en

const strings: Partial<Record<Lang, Partial<Record<StringKey, string>>>> = { en }

export function translate(lang: Lang, key: StringKey, params?: Params): string {
  return format(strings[lang]?.[key] ?? en[key], params)
}
