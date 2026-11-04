/** Convax namespace and complete shipped-language dictionaries. */
import { en } from './locales/en.ts'
import { zh } from './locales/zh.ts'
import { ja } from './locales/ja.ts'
import { es } from './locales/es.ts'
import { fr } from './locales/fr.ts'
import { de } from './locales/de.ts'
import { ru } from './locales/ru.ts'
import { pt } from './locales/pt.ts'

/** Dictionary namespace owned by the workspace. */
export const NS = 'convax'

/** Locale identifiers supported by the complete Convax UI. */
export const SUPPORTED_LOCALES = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const

/** One supported Convax locale identifier. */
export type ConvaxLocale = typeof SUPPORTED_LOCALES[number]

/** Runtime dictionaries registered together through the DSH locale service. */
export const dictionaries = { en, zh, ja, es, fr, de, ru, pt } as const

export { en, zh, ja, es, fr, de, ru, pt }
export type { ConvaxKey } from './locales/en.ts'
