/** Both tab strips ship the shared animation stylesheet and apply its compiled classes. */
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { build, type UserConfig } from 'tsdown'
import { describe, expect, it } from 'vitest'

type ConfigFactory = (options: Pick<UserConfig, 'env'>) => UserConfig[]

describe('Convax tab animation bundle', () => {
  it.each(['plugin-renderer', 'plugin-inernal-nodes-renderer'])('loads matching transition and settling rules in %s', async (directory) => {
    const root = resolve(import.meta.dirname, '../..', directory)
    const configPath = new URL(`file://${root}/tsdown.config.ts`).href
    const { default: configs } = await import(configPath) as { default: ConfigFactory }
    const config = configs({ env: {} }).find(config => config.platform === 'browser')
    if (config === undefined) throw new Error('Convax browser bundle configuration is missing')
    const builds = await build({
      ...config, cwd: root, config: false, tsconfig: false,
      write: false, clean: false, exports: false, report: false, logLevel: 'silent',
    })
    try {
      const chunk = builds.flatMap(bundle => bundle.chunks).find(chunk => chunk.type === 'chunk' && chunk.fileName === 'client.js')
      if (chunk?.type !== 'chunk') throw new Error('Convax client bundle is missing')
      const source = ts.createSourceFile('client.js', chunk.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const styles: string[] = []
      let shared: { name: string; classes: Record<string, string> } | undefined
      const scan = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) && node.text.includes('--dsh-convax-tab-offset') && node.text.includes('@keyframes')) {
          styles.push(node.text)
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
          && ts.isObjectLiteralExpression(node.initializer)) {
          const classes: Record<string, string> = {}
          for (const property of node.initializer.properties) {
            if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
              && ts.isStringLiteral(property.initializer)) {
              classes[property.name.text] = property.initializer.text
            }
          }
          if (classes.strip !== undefined && classes.tab !== undefined) shared = { name: node.name.text, classes }
        }
        ts.forEachChild(node, scan)
      }
      scan(source)
      expect(styles, 'The shared stylesheet must be present in the emitted client').toHaveLength(1)
      if (shared === undefined) throw new Error('Shared tab animation classes were not emitted')
      const sharedName = shared.name
      const uses: Record<string, number> = {}
      const count = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === sharedName) {
          uses[node.name.text] = (uses[node.name.text] ?? 0) + 1
        }
        ts.forEachChild(node, count)
      }
      count(source)
      expect(uses.strip, 'The owner applies the emitted strip class').toBe(1)
      expect(uses.tab, 'The owner applies the emitted tab class').toBe(1)

      const dom = new JSDOM()
      try {
        const style = dom.window.document.createElement('style')
        style.textContent = styles.join('\n')
        dom.window.document.head.appendChild(style)
        const rules = [...style.sheet?.cssRules ?? []]
        const styleRules = rules.filter((rule): rule is CSSStyleRule => rule instanceof dom.window.CSSStyleRule)
        const stripSelector = `.${shared.classes.strip}`
        const tabSelector = `.${shared.classes.tab}`
        const transition = styleRules.find(rule => rule.selectorText === `${stripSelector}[data-reordering] ${tabSelector}`)
        expect(transition?.style.getPropertyValue('transform')).toContain('--dsh-convax-tab-offset')
        expect(transition?.style.getPropertyValue('transition')).toContain('transform')
        expect(transition?.style.getPropertyValue('transition')).toContain('--ds-transition-duration-fast')
        const settling = styleRules.find(rule => rule.selectorText === `${tabSelector}[data-settling]`)
        const animation = settling?.style.getPropertyValue('animation')
        expect(animation).toContain('--ds-transition-duration-fast')
        const keyframes = rules.filter((rule): rule is CSSKeyframesRule => rule instanceof dom.window.CSSKeyframesRule)
        expect(keyframes.some(rule => animation?.includes(rule.name) && rule.cssText.includes('--dsh-convax-tab-settle'))).toBe(true)
        expect(rules.some(rule => rule instanceof dom.window.CSSMediaRule
          && /prefers-reduced-motion:\s*reduce/.test(rule.cssText))).toBe(true)
      } finally { dom.window.close() }
    } finally {
      for (const bundle of builds) await bundle[Symbol.asyncDispose]()
    }
  })
})
