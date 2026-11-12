import type { Locator } from 'playwright'

/** Sample a fixed wheel trace and compare frame spacing, browser main-thread work, and live DOM size. */
export async function measurePan(root: Locator) {
  const session = await root.page().context().newCDPSession(root.page())
  try {
    await session.send('Performance.enable')
    const before = await session.send('Performance.getMetrics')
    const frames = await root.evaluate(async (root) => {
      const count = (selector: string) => root.querySelectorAll(selector).length
      const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
      const camera = root.querySelector('.react-flow__viewport')
      if (camera === null) throw new Error('Pan trace requires a rendered camera')
      const nodes: number[] = []
      const edges: number[] = []
      const elements: number[] = []
      const intervals: number[] = []
      let midway = { x: 0, y: 0 }
      let previous = await frame()
      for (let i = 0; i < 90; i++) {
        root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          deltaX: i < 45 ? 22 : -22, deltaY: i < 45 ? 12 : -12 }))
        const next = await frame()
        if (i >= 5) intervals.push(next - previous)
        previous = next
        if (i === 44) {
          const transform = new DOMMatrixReadOnly(getComputedStyle(camera).transform)
          midway = { x: transform.e, y: transform.f }
        }
        if (i % 10 === 0) {
          nodes.push(count('.react-flow__node'))
          edges.push(count('[data-convax-edge]'))
          elements.push(count('*'))
        }
      }
      intervals.push(await frame() - previous)
      const sorted = intervals.toSorted((a, b) => a - b)
      const percentile = (value: number) => Math.round(sorted[Math.floor(sorted.length * value)]! * 10) / 10
      return { medianFrameMs: percentile(0.5), p95FrameMs: percentile(0.95), midway,
        peakMountedNodes: Math.max(...nodes), peakMountedEdges: Math.max(...edges), peakElements: Math.max(...elements) }
    })
    const after = await session.send('Performance.getMetrics')
    const elapsedMs = (name: string) => Math.round(1000 * ((after.metrics.find(item => item.name === name)?.value ?? 0)
      - (before.metrics.find(item => item.name === name)?.value ?? 0)))
    return { ...frames, taskMs: elapsedMs('TaskDuration'), scriptMs: elapsedMs('ScriptDuration'),
      layoutMs: elapsedMs('LayoutDuration'), styleMs: elapsedMs('RecalcStyleDuration') }
  } finally {
    await session.detach()
  }
}
