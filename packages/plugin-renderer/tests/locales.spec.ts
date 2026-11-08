/** Shipped Convax dictionaries preserve the English key set and interpolation parameters. */
import { describe, expect, it } from 'vitest'
import { dictionaries, en, SUPPORTED_LOCALES } from '../src/client/locales.ts'

const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/gu)].map(match => match[1] ?? '').sort()

describe('Convax locale resources', () => {
  it.each(SUPPORTED_LOCALES)('provides every UI key with unchanged placeholders in %s', (locale) => {
    const dictionary = dictionaries[locale]
    expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort())
    for (const [key, original] of Object.entries(en)) {
      const translated = dictionary[key as keyof typeof en]
      expect(translated.trim(), `${locale}.${key}`).not.toBe('')
      expect(placeholders(translated), `${locale}.${key}`).toEqual(placeholders(original))
      expect(translated, `${locale}.${key}`).not.toMatch(/[\u200b\ufeff]/u)
    }
  })

  it.each(SUPPORTED_LOCALES.filter(locale => locale !== 'en'))('translates language-dependent copy in %s', (locale) => {
    const dictionary = dictionaries[locale]
    const languageNeutral = new Set(['workspace.title', 'activity.itemLabel', 'media.resolution', 'media.metadata', 'media.position'])
    // These words are spelled identically in English and their translated languages.
    const sharedWords: Readonly<Record<string, readonly string[]>> = {
      es: ['terminal.title'],
      fr: ['chat.settingsConversation', 'media.volume', 'terminal.title', 'group.color.orange'],
      de: ['workspace.plugins', 'chat.thread', 'terminal.title', 'browser.title', 'group.color.orange'],
      pt: ['workspace.plugins', 'media.volume', 'terminal.title'],
    }
    for (const [key, original] of Object.entries(en)) {
      if (languageNeutral.has(key) || sharedWords[locale]?.includes(key)) continue
      expect(dictionary[key as keyof typeof en], `${locale}.${key}`).not.toBe(original)
    }
  })
})
