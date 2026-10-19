// The panel's own translation tables, so assertions follow the real wording in all 3 languages.
import { en, ru, uz } from '../../src/i18n/locales'

export type Lang = 'uz' | 'ru' | 'en'
const TABLES: Record<Lang, unknown> = { uz, ru, en }

export function tr(lang: Lang, key: string): string {
  let node: unknown = TABLES[lang]
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) throw new Error(`Missing translation ${lang}:${key}`)
    node = (node as Record<string, unknown>)[part]
  }
  if (typeof node !== 'string') throw new Error(`Missing translation ${lang}:${key}`)
  return node
}

/** English text (the e2e browser locale is en-US). */
export function t(key: string): string {
  return tr('en', key)
}
