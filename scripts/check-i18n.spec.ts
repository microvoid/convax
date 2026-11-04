/** Negative fixtures keep the outer Convax locale gate independent from DSH discovery roots. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkConvaxI18n } from './check-i18n.ts'

const locales = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt']
const client = 'packages/plugin-renderer/src/client'
const examples = ['packages/plugin-renderer/examples/counter', 'packages/plugin-host/templates/canvas-note']
const temporary: string[] = []

function write(root: string, file: string, text: string): void {
  const path = resolve(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'convax-i18n-check-'))
  temporary.push(root)
  const dictionary = { title: 'Example', count: '{count} items' }
  for (const locale of locales) write(root, `${client}/locales/${locale}.ts`, `export const ${locale} = ${JSON.stringify(dictionary)}\n`)
  write(root, `${client}/locales.ts`, `export const dictionaries = { ${locales.join(', ')} } as const\n`)
  for (const directory of ['packages/plugin-renderer', 'packages/plugin-inernal-nodes-host', 'packages/plugin-inernal-nodes-renderer', ...examples]) {
    for (const locale of locales) write(root, `${directory}/locale/${locale}.json`, JSON.stringify({ meta: { title: 'Example', description: 'Example plugin' } }))
  }
  for (const directory of examples) {
    write(root, `${directory}/client.js`, `ctx.locale.register('example', ${JSON.stringify(Object.fromEntries(locales.map(locale => [locale, dictionary])))})`)
  }
  write(root, `${client}/Card.tsx`, 'export const Card = ({ t }) => <button aria-label={t("count")}>{t("title")}</button>\n')
  return root
}

afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Convax i18n CI gate', () => {
  it('accepts the committed eight-language dictionaries and metadata', () => {
    expect(checkConvaxI18n(resolve(import.meta.dirname, '..'))).toEqual([])
  })

  it('accepts complete resources without executing third-party client code', () => {
    const root = fixture()
    const file = `${examples[0]}/client.js`
    write(root, file, `throw new Error('Plugin code must never execute during validation');\n${readFileSync(resolve(root, file), 'utf8')}`)
    expect(checkConvaxI18n(root)).toEqual([])
  })

  it('rejects a missing renderer language', () => {
    const root = fixture()
    rmSync(resolve(root, `${client}/locales/ja.ts`))
    expect(checkConvaxI18n(root)).toContainEqual(expect.objectContaining({ code: 'missing-locale', message: 'Missing ja dictionary.' }))
  })

  it('rejects a language omitted from the runtime registry', () => {
    const root = fixture()
    write(root, `${client}/locales.ts`, 'export const dictionaries = { en, zh }\n')
    expect(checkConvaxI18n(root)).toContainEqual(expect.objectContaining({ code: 'missing-locale', message: 'fr is not registered at runtime.' }))
  })

  it('rejects missing and unexpected renderer dictionary keys', () => {
    const root = fixture()
    write(root, `${client}/locales/fr.ts`, 'export const fr = { title: "Exemple", extra: "Extra" }')
    expect(checkConvaxI18n(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-key', message: 'fr.count is missing.' }),
      expect.objectContaining({ code: 'unexpected-key', message: 'fr.extra has no English source key.' }),
    ]))
  })

  it('rejects renamed, omitted and repeated placeholders', () => {
    const root = fixture()
    for (const [locale, count] of [['de', '{total} Elemente'], ['es', 'Elementos'], ['ru', '{count} {count}']]) {
      write(root, `${client}/locales/${locale}.ts`, `export const ${locale} = ${JSON.stringify({ title: 'Example', count })}`)
    }
    expect(checkConvaxI18n(root).filter(problem => problem.code === 'token-mismatch')).toHaveLength(3)
  })

  it('rejects missing package metadata, missing meta fields and duplicated UI JSON', () => {
    const root = fixture()
    rmSync(resolve(root, 'packages/plugin-renderer/locale/pt.json'))
    write(root, `${examples[0]}/locale/de.json`, JSON.stringify({ meta: { title: 'Example' } }))
    write(root, `${examples[1]}/locale/es.json`, JSON.stringify({ meta: { title: 'Example', description: 'Example plugin' }, ui: { save: 'Save' } }))
    expect(checkConvaxI18n(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-locale', message: 'Missing pt dictionary.' }),
      expect.objectContaining({ code: 'missing-key', message: 'meta.description is required.' }),
      expect.objectContaining({ code: 'invalid-resource', file: `${examples[1]}/locale/es.json` }),
    ]))
  })

  it('rejects missing third-party namespace languages and wrong placeholder names', () => {
    const root = fixture()
    const dictionaries = Object.fromEntries(locales.filter(locale => locale !== 'ja').map(locale => [locale, { title: 'Example', count: locale === 'fr' ? '{total} éléments' : '{count} items' }]))
    write(root, `${examples[0]}/client.js`, `ctx.locale.register('example', ${JSON.stringify(dictionaries)})`)
    expect(checkConvaxI18n(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-locale', file: `${examples[0]}/client.js`, message: 'Missing ja dictionary.' }),
      expect.objectContaining({ code: 'token-mismatch', file: `${examples[0]}/client.js` }),
    ]))
  })

  it('rejects hard-coded visible and accessible UI copy outside DSH', () => {
    const root = fixture()
    write(root, `${client}/Card.tsx`, 'export const Card = () => <button aria-label="Create a new canvas">New canvas</button>\n')
    const violations = checkConvaxI18n(root).filter(problem => problem.code === 'hardcoded-ui')
    expect(violations).toHaveLength(2)
    expect(violations.every(problem => problem.file === `${client}/Card.tsx`)).toBe(true)
  })

  it('checks the separately installed node plugins metadata', () => {
    const root = fixture()
    const directory = 'packages/plugin-inernal-nodes-renderer'
    rmSync(resolve(root, `${directory}/locale/ja.json`))
    expect(checkConvaxI18n(root)).toContainEqual(expect.objectContaining({
      code: 'missing-locale', file: `${directory}/locale`, message: 'Missing ja dictionary.',
    }))
  })

  it('rejects duplicate dictionary keys instead of silently accepting the last value', () => {
    const root = fixture()
    write(root, `${client}/locales/ja.ts`, 'export const ja = { title: "Example", title: "Duplicate", count: "{count} items" }')
    expect(checkConvaxI18n(root)).toContainEqual(expect.objectContaining({ code: 'invalid-resource', file: `${client}/locales/ja.ts` }))
  })
})
