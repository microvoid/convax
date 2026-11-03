import { describe, expect, it } from 'vitest'
import { resizeChat } from '../src/client/chat-size.ts'

describe('Convax Chat resizing', () => {
  it.each([
    [0.5, { width: 820, height: 800 }],
    [2, { width: 670, height: 710 }],
  ] as const)('converts viewport pointer movement through canvas zoom %s', (scale, expected) => {
    const start = { width: 620, height: 680 }
    expect(resizeChat(start, 100, 60, scale)).toEqual(expected)
    expect(start).toEqual({ width: 620, height: 680 })
  })

  it('clamps shrinking to the minimum width and scrollport height', () => {
    expect(resizeChat({ width: 620, height: 680 }, -1000, -1000, 1)).toEqual({ width: 400, height: 160 })
  })

  it('honors a larger requested scrollport minimum without lowering its layout floor', () => {
    const start = { width: 620, height: 680 }
    expect(resizeChat(start, 0, -1000, 1, 210)).toEqual({ width: 620, height: 210 })
    expect(resizeChat(start, 0, -1000, 1, 100)).toEqual({ width: 620, height: 160 })
  })

  it('allows growth beyond the viewport without a maximum size', () => {
    expect(resizeChat({ width: 620, height: 680 }, 3000, 2000, 1)).toEqual({ width: 3620, height: 2680 })
  })
})
