// @vitest-environment jsdom
/** Resource cards resize through the same pointer capture and keyboard gestures. */
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardResizeHandle } from '../src/client/CardResizeHandle.tsx'
import { resizeResource, type ResourceSize } from '../src/client/resource-size.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function fixture({ collapsed = false, contentVisible = true, size = { width: 500, height: 280 } }: {
  collapsed?: boolean
  contentVisible?: boolean
  size?: ResourceSize
} = {}) {
  const container = createRef<HTMLElement>()
  const content = createRef<HTMLDivElement>()
  const props = {
    container, content, size, collapsed, resize: resizeResource,
    preview: vi.fn<(size: ResourceSize | null) => void>(),
    commit: vi.fn<(size: ResourceSize) => void>(),
    label: 'Resize card', help: 'Drag to resize, or use the arrow keys',
  }
  const parentPointer = vi.fn()
  const parentKey = vi.fn()
  const view = render(<article ref={container} onPointerDown={parentPointer} onKeyDown={parentKey}>
    {contentVisible && <div ref={content}><span>Retained preview</span></div>}
    <CardResizeHandle {...props} />
  </article>)
  const root = container.current
  if (root === null) throw new Error('Expected the mounted card')
  Object.defineProperties(root, {
    offsetWidth: { configurable: true, value: 620 },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(100, 200, 310, 200) },
  })
  if (content.current !== null) Object.defineProperty(content.current, 'offsetHeight', { configurable: true, value: 360 })
  const grip = screen.getByRole('button', { name: props.label })
  let captured: number | undefined
  const pointerCapture = {
    setPointerCapture: vi.fn((id: number) => { captured = id }),
    hasPointerCapture: vi.fn((id: number) => captured === id),
    releasePointerCapture: vi.fn((id: number) => { if (captured === id) captured = undefined }),
  }
  for (const [name, value] of Object.entries(pointerCapture)) Object.defineProperty(grip, name, { configurable: true, value })
  return { ...view, props, root, grip, parentPointer, parentKey, pointerCapture }
}

function pointer(target: HTMLElement, type: string, x: number, y: number, pointerId = 7, button = 0): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
  Object.defineProperties(event, {
    pointerId: { value: pointerId }, pointerType: { value: 'mouse' }, isPrimary: { value: true },
  })
  fireEvent(target, event)
}

describe('Convax resource card resizing', () => {
  it('uses measured content and canvas zoom, retaining the preview until one final commit', () => {
    const b = fixture()
    const retained = screen.getByText('Retained preview')
    const focus = vi.spyOn(b.grip, 'focus')
    pointer(b.grip, 'pointerdown', 410, 420)
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    expect(document.activeElement).toBe(b.grip)
    expect(b.parentPointer).not.toHaveBeenCalled()
    expect(b.grip.hasAttribute('data-resizing')).toBe(true)
    expect(b.pointerCapture.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7)
    pointer(b.grip, 'pointermove', 450, 440)
    expect(b.props.preview).toHaveBeenLastCalledWith({ width: 700, height: 400 })
    expect(b.props.commit).not.toHaveBeenCalled()
    pointer(b.grip, 'pointerup', 470, 450)
    expect(b.props.commit).toHaveBeenCalledExactlyOnceWith({ width: 740, height: 420 })
    expect(b.props.preview).toHaveBeenLastCalledWith(null)
    expect(b.pointerCapture.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7)
    expect(b.grip.hasAttribute('data-resizing')).toBe(false)
    expect(screen.getByText('Retained preview')).toBe(retained)
    pointer(b.grip, 'pointermove', 500, 500)
    pointer(b.grip, 'pointerup', 500, 500)
    expect(b.props.commit).toHaveBeenCalledOnce()
  })

  it('does not commit a press and release without displacement', () => {
    const b = fixture()
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointerup', 100, 100)
    expect(b.props.commit).not.toHaveBeenCalled()
    expect(b.props.preview).toHaveBeenCalledExactlyOnceWith(null)
    expect(b.pointerCapture.releasePointerCapture).toHaveBeenCalledOnce()
  })

  it('ignores secondary buttons and another pointer during the captured gesture', () => {
    const b = fixture()
    pointer(b.grip, 'pointerdown', 100, 100, 7, 2)
    expect(b.pointerCapture.setPointerCapture).not.toHaveBeenCalled()
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointerdown', 200, 200, 8)
    pointer(b.grip, 'pointermove', 300, 300, 8)
    pointer(b.grip, 'pointerup', 300, 300, 8)
    expect(b.props.preview).not.toHaveBeenCalled()
    expect(b.props.commit).not.toHaveBeenCalled()
    pointer(b.grip, 'pointerup', 110, 120)
    expect(b.props.commit).toHaveBeenCalledExactlyOnceWith({ width: 640, height: 400 })
    expect(b.pointerCapture.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('keeps resizing after capture loss and commits the final release on the canvas once', () => {
    const b = fixture()
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointermove', 120, 130)
    b.grip.releasePointerCapture(7)
    pointer(b.grip, 'lostpointercapture', 120, 130)
    expect(b.grip.hasAttribute('data-resizing')).toBe(true)
    expect(b.props.commit).not.toHaveBeenCalled()
    pointer(document.body, 'pointermove', 140, 150)
    expect(b.props.preview).toHaveBeenLastCalledWith({ width: 700, height: 460 })
    pointer(document.body, 'pointerup', 160, 170)
    expect(b.props.commit).toHaveBeenCalledExactlyOnceWith({ width: 740, height: 500 })
    expect(b.props.preview).toHaveBeenLastCalledWith(null)
    expect(b.grip.hasAttribute('data-resizing')).toBe(false)
    pointer(b.grip, 'pointerup', 180, 190)
    expect(b.props.commit).toHaveBeenCalledOnce()
  })

  it.each(['pointercancel', 'blur', 'window blur', 'Escape'])('cancels the gesture on %s without saving it', (ending) => {
    const b = fixture()
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointermove', 120, 130)
    expect(b.props.preview).toHaveBeenLastCalledWith({ width: 660, height: 420 })
    if (ending === 'blur') fireEvent.blur(b.grip)
    else if (ending === 'window blur') fireEvent(window, new Event('blur'))
    else if (ending === 'Escape') fireEvent.keyDown(b.grip, { key: 'Escape' })
    else pointer(b.grip, ending, 120, 130)
    expect(b.grip.hasAttribute('data-resizing')).toBe(false)
    expect(b.props.preview).toHaveBeenLastCalledWith(null)
    expect(b.pointerCapture.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7)
    pointer(b.grip, 'pointerup', 120, 130)
    expect(b.props.commit).not.toHaveBeenCalled()
    expect(b.parentKey).not.toHaveBeenCalled()
  })

  it.each(['release', 'pointercancel', 'blur', 'window blur', 'Escape', 'unmount'])('removes document gesture listeners after capture loss and %s', (ending) => {
    const b = fixture()
    const listen = vi.spyOn(document, 'addEventListener')
    const unlisten = vi.spyOn(document, 'removeEventListener')
    const listenWindow = vi.spyOn(window, 'addEventListener')
    const unlistenWindow = vi.spyOn(window, 'removeEventListener')
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointermove', 120, 130)
    b.grip.releasePointerCapture(7)
    pointer(b.grip, 'lostpointercapture', 120, 130)
    const listeners = listen.mock.calls.filter(([type]) => ['pointermove', 'pointerup', 'pointercancel'].includes(type))
    expect(listeners).toHaveLength(3)
    const blur = listenWindow.mock.calls.find(([type]) => type === 'blur')
    expect(blur).toBeDefined()
    if (ending === 'release') pointer(document.body, 'pointerup', 140, 150)
    else if (ending === 'pointercancel') pointer(document.body, 'pointercancel', 140, 150)
    else if (ending === 'blur') fireEvent.blur(b.grip)
    else if (ending === 'window blur') fireEvent(window, new Event('blur'))
    else if (ending === 'Escape') fireEvent.keyDown(b.grip, { key: 'Escape' })
    else b.unmount()
    for (const listener of listeners) expect(unlisten).toHaveBeenCalledWith(...listener)
    expect(unlistenWindow).toHaveBeenCalledWith(...blur!)
    const previews = b.props.preview.mock.calls.length
    pointer(document.body, 'pointermove', 180, 190)
    pointer(document.body, 'pointerup', 180, 190)
    expect(b.props.preview).toHaveBeenCalledTimes(previews)
    expect(b.props.preview).toHaveBeenLastCalledWith(null)
    expect(b.props.commit).toHaveBeenCalledTimes(ending === 'release' ? 1 : 0)
  })

  it('releases pointer capture and clears the current preview callback on unmount', () => {
    const b = fixture()
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointermove', 120, 130)
    const preview = vi.fn<(size: ResourceSize | null) => void>()
    b.rerender(<article ref={b.props.container}>
      <div ref={b.props.content} />
      <CardResizeHandle {...b.props} preview={preview} />
    </article>)
    b.unmount()
    expect(b.pointerCapture.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7)
    expect(preview).toHaveBeenCalledExactlyOnceWith(null)
    expect(b.props.commit).not.toHaveBeenCalled()
  })

  it.each(['layout width', 'screen width'])('does not capture an unmeasurable %s', (zero) => {
    const b = fixture()
    if (zero === 'layout width') Object.defineProperty(b.root, 'offsetWidth', { value: 0 })
    else Object.defineProperty(b.root, 'getBoundingClientRect', { value: () => new DOMRect(0, 0, 0, 100) })
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointermove', 120, 130)
    pointer(b.grip, 'pointerup', 120, 130)
    expect(b.pointerCapture.setPointerCapture).not.toHaveBeenCalled()
    expect(b.props.preview).not.toHaveBeenCalled()
    expect(b.props.commit).not.toHaveBeenCalled()
  })

  it('resizes a collapsed card horizontally and preserves its saved expanded height', () => {
    const b = fixture({ collapsed: true, contentVisible: false, size: { width: 500, height: 110 } })
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointermove', 120, 200)
    expect(b.props.preview).toHaveBeenLastCalledWith({ width: 660, height: 110 })
    pointer(b.grip, 'pointerup', 130, 300)
    expect(b.props.commit).toHaveBeenCalledExactlyOnceWith({ width: 680, height: 110 })
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointerup', 100, 300)
    expect(b.props.commit).toHaveBeenCalledOnce()
  })

  it('uses saved height when an expanded placeholder has no measurable content yet', () => {
    const b = fixture({ contentVisible: false })
    pointer(b.grip, 'pointerdown', 100, 100)
    pointer(b.grip, 'pointerup', 110, 120)
    expect(b.props.commit).toHaveBeenCalledExactlyOnceWith({ width: 640, height: 320 })
  })

  it.each([
    ['ArrowLeft', false, { width: 490, height: 280 }],
    ['ArrowRight', false, { width: 510, height: 280 }],
    ['ArrowUp', false, { width: 500, height: 270 }],
    ['ArrowDown', false, { width: 500, height: 290 }],
    ['ArrowRight', true, { width: 510, height: 280 }],
  ] as const)('uses stored canvas dimensions for %s with Shift=%s', (key, shiftKey, expected) => {
    const b = fixture()
    fireEvent.keyDown(b.grip, { key, shiftKey })
    expect(b.props.commit).toHaveBeenCalledExactlyOnceWith(expected)
    expect(b.props.preview).not.toHaveBeenCalled()
    expect(b.parentKey).not.toHaveBeenCalled()
  })

  it('leaves collapsed height unchanged with keyboard resizing and ignores vertical arrows', () => {
    const b = fixture({ collapsed: true, size: { width: 500, height: 110 } })
    fireEvent.keyDown(b.grip, { key: 'ArrowUp' })
    fireEvent.keyDown(b.grip, { key: 'ArrowDown' })
    expect(b.props.commit).not.toHaveBeenCalled()
    fireEvent.keyDown(b.grip, { key: 'ArrowRight' })
    expect(b.props.commit).toHaveBeenCalledExactlyOnceWith({ width: 510, height: 110 })
  })

  it('ignores modifiers, composition, unrelated keys, and arrow keys during a pointer gesture', () => {
    const b = fixture()
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      fireEvent.keyDown(b.grip, { key: 'ArrowRight', ...modifiers })
    }
    fireEvent.keyDown(b.grip, { key: 'Enter' })
    pointer(b.grip, 'pointerdown', 100, 100)
    fireEvent.keyDown(b.grip, { key: 'ArrowRight' })
    expect(b.props.commit).not.toHaveBeenCalled()
    expect(b.props.preview).not.toHaveBeenCalled()
  })
})
