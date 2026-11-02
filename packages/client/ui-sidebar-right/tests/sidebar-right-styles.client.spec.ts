/** Right sidebar slide style contracts. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/shell/SidebarRight.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
const host = String.raw`:global\(\[data-dockkit-host='dock'\]\)`

function ruleBlocks(source: string) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors = '', body = '']) => ({
    selectors: selectors.split(',').map(selector => selector.trim()),
    declarations: new Map(body.split(';').filter(part => part.includes(':')).map((part): [string, string] => {
      const colon = part.indexOf(':')
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' ')]
    })),
  }))
}

function declarations(selector: string): Map<string, string> {
  return ruleBlocks(css).find(rule => rule.selectors.includes(selector))?.declarations ?? new Map<string, string>()
}

function atRuleBodies(prelude: string): string[] {
  const escaped = prelude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'g'))].map(([, body = '']) => body)
}

const ordinary = ruleBlocks(css.replace(/@(starting-style|media \(prefers-reduced-motion: reduce\))\s*\{[\s\S]*?\n\}/g, ''))

function transitionTiming(value: string, property: string): string | undefined {
  return value.split(',').map(entry => entry.trim()).find(entry => entry.startsWith(`${property} `))?.slice(property.length).trim()
}

describe('SidebarRight.module.css', () => {
  it('starts docked items mounted by an opening at the closed position', () => {
    expect(css).toMatch(new RegExp(String.raw`@starting-style\s*\{\s*\.panel\[data-sidebar-right-opening\] ${host},[^{}]*\{`
      + String.raw`\s*transform: translateX\(var\(--dsh-sidebar-width\)\);\s*}\s*}`))
  })

  it('removes the open slide as well as the close slide for reduced motion', () => {
    expect(css).toMatch(new RegExp(String.raw`@media \(prefers-reduced-motion: reduce\)\s*\{[^{}]*`
      + String.raw`\.panel\[data-sidebar-right-open\] ${host}[^{}]*\{\s*transition: none;\s*}`))
  })

  it('keeps the attached panel anchored beside Chat while its occupied width and gap change together', () => {
    const panel = declarations('.embedded .panel')
    expect(panel.get('left')).toBe('0')
    expect(panel.get('right')).toBe('auto')
    const transition = declarations('.embedded').get('transition') ?? ''
    const widthTiming = transitionTiming(transition, 'width')
    expect(widthTiming).toBeDefined()
    expect(transitionTiming(transition, 'margin-inline-start')).toBe(widthTiming)
  })

  it('fades only docked content so closing does not hide or clip independent floating panels', () => {
    const floatingSensitive = ['opacity', 'visibility', 'transform']
    const embeddedEffects = ordinary.filter(rule => floatingSensitive.some(property => rule.declarations.has(property)))
      .flatMap(rule => rule.selectors.filter(selector => selector.startsWith('.embedded ')).map(selector => ({ selector, rule })))
    expect(embeddedEffects.length).toBeGreaterThan(0)
    for (const { selector, rule } of embeddedEffects) {
      expect(selector).toMatch(/\[data-dockkit-(?:host='dock'|empty|divider)\]/u)
      if (rule.declarations.has('transform')) expect(rule.declarations.get('transform')).toBe('none')
    }
    expect(declarations('.embedded .panel').get('overflow')).toBe('visible')
    const opening = atRuleBodies('@starting-style').flatMap(ruleBlocks)
      .filter(rule => rule.selectors.some(selector => selector.startsWith('.embedded ')))
    expect(opening.length).toBeGreaterThan(0)
    for (const rule of opening) expect(rule.declarations.get('transform')).toBe('none')
  })

  it('removes every embedded geometry and fade transition when reduced motion is requested', () => {
    const animated = ordinary.filter(rule => rule.declarations.has('transition') && rule.declarations.get('transition') !== 'none')
      .flatMap(rule => rule.selectors.filter(selector => selector.startsWith('.embedded')))
    const reduced = atRuleBodies('@media (prefers-reduced-motion: reduce)').flatMap(ruleBlocks)
    expect(animated.length).toBeGreaterThan(0)
    for (const selector of animated) {
      const overrides = reduced.filter(rule => rule.selectors.includes(selector))
      expect(overrides.at(-1)?.declarations.get('transition')).toBe('none')
    }
  })
})
