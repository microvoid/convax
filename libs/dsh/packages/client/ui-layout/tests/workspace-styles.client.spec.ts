/** Window chrome remains outside a full-width workspace's interactive area. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/AppFrame.module.css', import.meta.url), 'utf8')

describe('full-width workspace styles', () => {
  it('clears macOS traffic lights inside the workspace while retaining the shared overlay inset', () => {
    const content = css.match(/:global\(\[data-platform='darwin'\]\) \.frame\[data-workspace-active\] \.centerCol\s*\{([^}]+)\}/)?.[1]
    expect(content).toContain('padding-top: var(--dsh-frame-top-clearance)')
    expect(content).toContain('border-left: none')
    expect(content).not.toContain('--dsh-frame-top-clearance:')
    expect(css).toMatch(/\.workspaceChrome\s*\{[^}]*height: var\(--dsh-frame-top-clearance\)/)
    expect(css).toMatch(
      /:global\(\[data-platform='darwin'\]\) \.frame\[data-workspace-active\],[\s\S]*?--dsh-frame-leading-clearance: 0px;/,
    )
  })

  it('hides native column content without removing the Windows caption or global overlay hosts', () => {
    expect(css).toMatch(/\.sidebarCol\[hidden\],\s*\.rightbarCol\[hidden\]\s*\{\s*display: none;/)
    expect(css).toMatch(/\.frame\[data-workspace-active\] \.centerCol\s*\{\s*grid-column: 1 \/ -1;/)
    expect(css).toMatch(/:global\(\[data-windows-titlebar\]\) \.frame\s*\{[^}]*padding-top: var\(--dsh-windows-titlebar-height\)/)
    expect(css).toMatch(/\.overlayLayer\s*\{[^}]*inset: 0;/)
  })

  it('lets an integrated workspace titlebar own the native window strip without changing overlay clearance', () => {
    const integrated = String.raw`\.frame\[data-workspace-active\]:has\(> \.centerCol \[data-workspace-titlebar=['"]integrated['"]\]\)`
    const content = css.match(new RegExp(String.raw`:global\(\[data-platform='darwin'\]\) ${integrated} \.centerCol\s*\{([^}]+)\}`))?.[1]
    expect(content).toContain('padding-top: 0')
    const band = css.match(new RegExp(String.raw`${integrated} \.workspaceChrome\s*\{([^}]+)\}`))?.[1]
    expect(band).toContain('display: none')
    expect(css).toMatch(new RegExp(String.raw`${integrated}\s*\{[^}]*--dsh-frame-leading-clearance: 88px;`))
    expect(css).toMatch(new RegExp(String.raw`:global\(\[data-platform='darwin'\]\[data-fullscreen\]\) ${integrated}\s*\{[^}]*--dsh-frame-leading-clearance: 12px;`))
    expect(css).toMatch(/:global\(html\[data-platform='darwin'\]\)\s*\{\s*--dsh-frame-top-clearance: 48px;/)
    expect(css).toContain('--dsh-frame-overlay-top: calc(var(--dsh-frame-top-clearance) + 20px)')
  })
})
