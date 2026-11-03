/** Canvas navigation shares the Desktop window's own titlebar row. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/Workspace.module.css', import.meta.url), 'utf8')
const markup = readFileSync(new URL('../src/client/Workspace.tsx', import.meta.url), 'utf8')

describe('Convax window titlebar', () => {
  it('opts its 48px navigation row into integrated chrome while preserving its own padding', () => {
    const navigation = markup.match(/<nav\s[^>]*className=\{css\.tabbar\}[^>]*>/)?.[0]
    expect(navigation).toContain('data-workspace-titlebar="integrated"')
    expect(navigation).toContain('data-window-drag')
    const row = css.match(/\.tabbar\s*\{([^}]+)\}/)?.[1]
    expect(row).toContain('box-sizing: border-box')
    expect(row).toContain('min-height: 48px')
    expect(row).toContain('padding: 4px 12px')
    const native = css.match(/:global\(\[data-platform='darwin'\]\) \.tabbar\s*\{([^}]+)\}/)?.[1]
    expect(native).toContain('padding-inline-start: var(--dsh-frame-leading-clearance)')
    expect(native).not.toContain('--dsh-frame-top-clearance:')
    expect(css).not.toMatch(/(?:-webkit-)?app-region:\s*drag(?:\s|;)/)
    const tabs = css.match(/:global\(\[data-platform='darwin'\]\) \.tabs\s*\{([^}]+)\}/)?.[1]
    expect(tabs).toContain('-webkit-app-region: no-drag')
    expect(css.match(/-webkit-app-region:\s*no-drag/g)).toHaveLength(1)
  })

  it('keeps titlebar navigation first in visual and keyboard reading order', () => {
    const workspace = css.match(/\.workspace\s*\{([^}]+)\}/)?.[1]
    const navigation = css.match(/\.tabbar\s*\{([^}]+)\}/)?.[1]
    expect(workspace).toContain('display: flex')
    expect(workspace).toContain('flex-direction: column')
    expect(workspace).toContain('reading-flow: flex-visual')
    expect(navigation).toContain('order: -1')
  })
})
