/// <reference types="node" />
/** Convax-owned locale coverage and product-copy gate; retained DSH helpers are read-only imports. */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { hasInvisibleLocaleCharacters, localeTokens, SHIPPED_LOCALE_IDS } from '../libs/dsh/scripts/shipped-locales.ts'
import { findUiI18nViolations } from '../libs/dsh/scripts/verify-client-ui-i18n.ts'

const client = 'packages/plugin-renderer/src/client'
const examples = [
  'packages/plugin-renderer/examples/counter',
  'packages/plugin-host/templates/canvas-note',
] as const
const metadataDirectories = ['packages/plugin-renderer', ...examples]

/** One actionable failure produced by the Convax locale gate. */
export interface ConvaxI18nProblem {
  /** Stable category for test fixtures and CI integrations. */
  code: 'missing-resource' | 'invalid-resource' | 'missing-locale' | 'missing-key' | 'unexpected-key' | 'token-mismatch' | 'hardcoded-ui'
  /** Path relative to the Convax repository root. */
  file: string
  /** Diagnostic detail, including the affected dictionary key where applicable. */
  message: string
}

type Dictionary = Record<string, string>

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
    ? unwrap(expression.expression) : expression
}

function propertyName(property: ts.PropertyName): string | undefined {
  return ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : undefined
}

function initializer(source: ts.SourceFile, name: string): ts.Expression | undefined {
  let result: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      result = unwrap(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

function stringDictionary(expression: ts.Expression, file: string, problems: ConvaxI18nProblem[]): Dictionary | undefined {
  const object = unwrap(expression)
  if (!ts.isObjectLiteralExpression(object)) {
    problems.push({ code: 'invalid-resource', file, message: 'Locale dictionaries must be static objects of strings.' })
    return
  }
  const entries = new Map<string, string>()
  for (const property of object.properties) {
    const name = ts.isPropertyAssignment(property) ? propertyName(property.name) : undefined
    const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined
    if (name === undefined || value === undefined || !ts.isStringLiteralLike(value) || entries.has(name)) {
      problems.push({ code: 'invalid-resource', file, message: 'Locale keys must be unique static strings with string values.' })
      continue
    }
    entries.set(name, value.text)
  }
  return Object.fromEntries(entries)
}

function compareDictionaries(file: string, dictionaries: Record<string, Dictionary | undefined>, problems: ConvaxI18nProblem[]): void {
  const english = dictionaries.en
  for (const locale of SHIPPED_LOCALE_IDS) {
    const dictionary = dictionaries[locale]
    if (!dictionary) {
      problems.push({ code: 'missing-locale', file, message: `Missing ${locale} dictionary.` })
      continue
    }
    for (const [key, text] of Object.entries(dictionary)) {
      if (text.trim() === '' || hasInvisibleLocaleCharacters(text)) {
        problems.push({ code: 'invalid-resource', file, message: `${locale}.${key} is empty or contains invisible translation artifacts.` })
      }
      if (english && !Object.hasOwn(english, key)) {
        problems.push({ code: 'unexpected-key', file, message: `${locale}.${key} has no English source key.` })
      }
    }
    for (const [key, source] of Object.entries(english ?? {})) {
      const translated = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined
      if (translated === undefined) {
        problems.push({ code: 'missing-key', file, message: `${locale}.${key} is missing.` })
      } else if (JSON.stringify(localeTokens(source)) !== JSON.stringify(localeTokens(translated))) {
        problems.push({ code: 'token-mismatch', file, message: `${locale}.${key} must preserve ${JSON.stringify(localeTokens(source))}.` })
      }
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Inspect the outer Convax repository without executing plugin factories or modifying DSH.
 * @param root - Convax checkout, or a fixture with the same resource paths.
 * @returns Every locale coverage, interpolation, metadata, or hard-coded-copy failure.
 */
export function checkConvaxI18n(root: string): ConvaxI18nProblem[] {
  const problems: ConvaxI18nProblem[] = []
  const read = (file: string): string | undefined => {
    if (!existsSync(resolve(root, file))) {
      problems.push({ code: 'missing-resource', file, message: 'Required locale resource is missing.' })
      return
    }
    return readFileSync(resolve(root, file), 'utf8')
  }
  const parse = (file: string): ts.SourceFile | undefined => {
    const text = read(file)
    return text === undefined ? undefined : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  }

  const rendererDictionaries: Record<string, Dictionary> = {}
  for (const locale of SHIPPED_LOCALE_IDS) {
    const file = `${client}/locales/${locale}.ts`
    const source = parse(file)
    if (!source) continue
    const expression = initializer(source, locale)
    if (!expression) {
      problems.push({ code: 'invalid-resource', file, message: `Missing ${locale} dictionary declaration.` })
      continue
    }
    const dictionary = stringDictionary(expression, file, problems)
    if (dictionary) rendererDictionaries[locale] = dictionary
  }
  compareDictionaries(`${client}/locales`, rendererDictionaries, problems)

  const registryFile = `${client}/locales.ts`
  const registrySource = parse(registryFile)
  const registry = registrySource && initializer(registrySource, 'dictionaries')
  if (!registry || !ts.isObjectLiteralExpression(registry)) {
    problems.push({ code: 'invalid-resource', file: registryFile, message: 'Missing runtime dictionary registry.' })
  } else {
    const registered = new Set<string>()
    for (const property of registry.properties) {
      if (ts.isShorthandPropertyAssignment(property)) registered.add(property.name.text)
      else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
        && propertyName(property.name) === property.initializer.text) {
        registered.add(property.initializer.text)
      } else {
        problems.push({ code: 'invalid-resource', file: registryFile, message: 'Each registered locale must reference its own dictionary.' })
      }
    }
    for (const locale of SHIPPED_LOCALE_IDS) {
      if (!registered.has(locale)) problems.push({ code: 'missing-locale', file: registryFile, message: `${locale} is not registered at runtime.` })
    }
  }

  for (const directory of metadataDirectories) {
    const dictionaries: Record<string, Dictionary> = {}
    for (const locale of SHIPPED_LOCALE_IDS) {
      const file = `${directory}/locale/${locale}.json`
      const text = read(file)
      if (text === undefined) continue
      let json: unknown
      try { json = JSON.parse(text) }
      catch {
        problems.push({ code: 'invalid-resource', file, message: 'Invalid locale JSON.' })
        continue
      }
      if (!record(json) || Object.keys(json).length !== 1 || !record(json.meta)) {
        problems.push({ code: 'invalid-resource', file, message: 'Package locale JSON must contain only meta; UI copy belongs to its namespace.' })
        continue
      }
      const metadata: Dictionary = {}
      for (const [key, value] of Object.entries(json.meta)) {
        if (typeof value === 'string') metadata[key] = value
        else problems.push({ code: 'invalid-resource', file, message: `meta.${key} must be a string.` })
      }
      for (const key of ['title', 'description']) {
        if (!Object.hasOwn(metadata, key)) problems.push({ code: 'missing-key', file, message: `meta.${key} is required.` })
      }
      dictionaries[locale] = metadata
    }
    compareDictionaries(`${directory}/locale`, dictionaries, problems)
  }

  for (const directory of examples) {
    const file = `${directory}/client.js`
    const source = parse(file)
    if (!source) continue
    let namespaces = 0
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'register' && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.name.text === 'locale') {
        namespaces++
        const argument = node.arguments.at(1)
        const dictionaryExpression = argument === undefined ? undefined : unwrap(argument)
        const dictionaries: Record<string, Dictionary> = {}
        if (!dictionaryExpression || !ts.isObjectLiteralExpression(dictionaryExpression)) {
          problems.push({ code: 'invalid-resource', file, message: 'Plugin namespace registration must provide static locale dictionaries.' })
        } else {
          for (const property of dictionaryExpression.properties) {
            if (!ts.isPropertyAssignment(property)) {
              problems.push({ code: 'invalid-resource', file, message: 'Plugin locale registrations must declare each language explicitly.' })
              continue
            }
            const locale = propertyName(property.name)
            const dictionary = stringDictionary(property.initializer, file, problems)
            if (locale && dictionary) dictionaries[locale] = dictionary
          }
          compareDictionaries(file, dictionaries, problems)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (namespaces === 0) problems.push({ code: 'invalid-resource', file, message: 'Plugin example must register its own locale namespace.' })
  }

  const sources = globSync('packages/*/src/client/**/*.{ts,tsx}', { cwd: root }).sort()
  if (sources.length === 0) problems.push({ code: 'missing-resource', file: 'packages/*/src/client', message: 'No Convax Client source files were found.' })
  for (const file of sources) {
    for (const violation of findUiI18nViolations(file, readFileSync(resolve(root, file), 'utf8'))) {
      problems.push({ code: 'hardcoded-ui', file, message: `${violation.line}:${violation.column} ${violation.reason}: ${JSON.stringify(violation.text)}` })
    }
  }
  return problems
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const problems = checkConvaxI18n(resolve(import.meta.dirname, '..'))
  for (const problem of problems) console.error(`${problem.file}: [${problem.code}] ${problem.message}`)
  if (problems.length > 0) process.exitCode = 1
  else console.log('check-i18n: Convax dictionaries, package metadata, plugin namespaces and Client UI copy passed for all 8 shipped locales.')
}
