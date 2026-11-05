import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { DATE_LOCALES, htmlLang, type Lang, type Params } from '@arareader/i18n'
import { translate, type StringKey } from './strings'

export type TFunc = (key: StringKey, params?: Params) => string

interface LocaleValue {
  lang: Lang
  setLang: (lang: Lang) => void
}

const LocaleContext = createContext<LocaleValue>({ lang: 'en', setLang: () => {} })

export function LocaleProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial)
  const value = useMemo<LocaleValue>(
    () => ({
      lang,
      setLang: (next) => {
        setLangState(next)
        document.documentElement.lang = htmlLang(next)
        void window.reader.setLanguage(next)
      },
    }),
    [lang],
  )
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export interface I18n {
  lang: Lang
  setLang: (lang: Lang) => void
  t: TFunc
  /** BCP-47 locale for date/number formatting */
  dateLocale: string
}

export function useI18n(): I18n {
  const { lang, setLang } = useContext(LocaleContext)
  return {
    lang,
    setLang,
    t: (key, params) => translate(lang, key, params),
    dateLocale: DATE_LOCALES[lang],
  }
}
