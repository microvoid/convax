// @vitest-environment jsdom
import { createRef, type RefObject } from 'react'
import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useToolsCardHeight } from '../src/client/use-tools-card-height.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const CARD_HEIGHT_PROPERTY = '--dsh-convax-chat-card-height'

interface SubjectProps {
  readonly bodyRef: RefObject<HTMLDivElement>
  readonly toolsRef: RefObject<HTMLDivElement>
  readonly active: boolean
  readonly ready: boolean
  readonly nativeMounted?: boolean
  readonly layoutChanged: () => void
}

function Subject({ bodyRef, toolsRef, active, ready, nativeMounted = true, layoutChanged }: SubjectProps) {
  useToolsCardHeight(bodyRef, toolsRef, active, ready, layoutChanged)
  return <div data-convax-chat="" data-testid="chat">
    <div data-convax-chat-header="" data-testid="header" />
    <div ref={bodyRef} data-testid="body">
      {nativeMounted && <><div data-conversation-scroll="" data-testid="scroll" /><div data-composer-seat="" /></>}
    </div>
    <div ref={toolsRef} data-testid="tools" />
  </div>
}

function resizeObservers() {
  const observers: {
    observe: Mock<ResizeObserver['observe']>
    disconnect: Mock<ResizeObserver['disconnect']>
    notify: () => void
  }[] = []
  vi.stubGlobal('ResizeObserver', vi.fn(function (callback: ResizeObserverCallback) {
    const observe = vi.fn<ResizeObserver['observe']>()
    const disconnect = vi.fn<ResizeObserver['disconnect']>()
    const instance: ResizeObserver = { observe, unobserve: vi.fn(), disconnect }
    observers.push({ observe, disconnect, notify: () => { callback([], instance) } })
    return instance
  }))
  return observers
}

function mount(active = true, ready = true, nativeMounted = true) {
  const bodyRef = createRef<HTMLDivElement>()
  const toolsRef = createRef<HTMLDivElement>()
  const layoutChanged = vi.fn<() => void>()
  const view = render(<Subject bodyRef={bodyRef} toolsRef={toolsRef}
    active={active} ready={ready} nativeMounted={nativeMounted} layoutChanged={layoutChanged} />)
  const query = within(view.container)
  const chat = query.getByTestId('chat')
  const header = query.getByTestId('header')
  const body = query.getByTestId('body')
  const tools = query.getByTestId('tools')
  const geometry = { top: 100, width: 620, header: 40, scroll: 480, composer: 100, scale: 1 }
  Object.defineProperty(body, 'offsetWidth', { configurable: true, get: () => geometry.width })
  const bounds = (offset: number, height: number): DOMRect => new DOMRect(
    0, geometry.top + offset * geometry.scale, geometry.width * geometry.scale, height * geometry.scale,
  )
  chat.getBoundingClientRect = () => bounds(0, geometry.header + geometry.scroll + 12 + geometry.composer)
  header.getBoundingClientRect = () => bounds(0, geometry.header)
  body.getBoundingClientRect = () => bounds(geometry.header,
    query.queryByTestId('scroll') === null ? geometry.scroll : geometry.scroll + 12 + geometry.composer)
  const measureTranscript = (): void => {
    const scroll = query.queryByTestId('scroll')
    if (scroll !== null) scroll.getBoundingClientRect = () => bounds(geometry.header, geometry.scroll)
  }
  measureTranscript()
  return {
    ...view, chat, header, body, tools, geometry, layoutChanged,
    attachNative: () => {
      view.rerender(<Subject bodyRef={bodyRef} toolsRef={toolsRef} active={active} ready={ready} layoutChanged={layoutChanged} />)
      measureTranscript()
    },
    update: (nextActive: boolean, nextReady: boolean, nextLayoutChanged = layoutChanged) => {
      view.rerender(<Subject bodyRef={bodyRef} toolsRef={toolsRef}
        active={nextActive} ready={nextReady} layoutChanged={nextLayoutChanged} />)
    },
  }
}

describe('Convax tool card height', () => {
  it('excludes the composer and keeps the tool height when only the composer grows', () => {
    const observers = resizeObservers()
    const b = mount()
    const observer = observers[0]!
    act(observer.notify)
    expect(b.tools.style.height).toBe('520px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('520px')
    expect(b.layoutChanged).toHaveBeenCalledOnce()
    b.geometry.composer = 280
    act(observer.notify)
    expect(b.tools.style.height).toBe('520px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('520px')
    expect(b.layoutChanged).toHaveBeenCalledOnce()
  })

  it('preserves the reserved height until the native slot attaches, then excludes the composer and follows transcript resizing', () => {
    const observers = resizeObservers()
    const b = mount(true, true, false)
    act(observers[0]!.notify)
    expect(b.tools.style.height).toBe('520px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('520px')
    b.attachNative()
    b.geometry.composer = 280
    act(observers[0]!.notify)
    expect(b.tools.style.height).toBe('520px')
    expect(b.layoutChanged).toHaveBeenCalledOnce()
    b.geometry.scroll = 640
    act(observers[0]!.notify)
    expect(b.tools.style.height).toBe('680px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('680px')
    expect(b.layoutChanged).toHaveBeenCalledTimes(2)
  })

  it('follows transcript resizing and header height changes', () => {
    const observers = resizeObservers()
    const b = mount()
    act(observers[0]!.notify)
    b.geometry.scroll = 640
    act(observers[0]!.notify)
    expect(b.tools.style.height).toBe('680px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('680px')
    expect(b.layoutChanged).toHaveBeenCalledTimes(2)
    b.geometry.header = 64
    act(observers[0]!.notify)
    expect(b.tools.style.height).toBe('704px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('704px')
    expect(b.layoutChanged).toHaveBeenCalledTimes(3)
  })

  it.each([0.5, 2])('writes unscaled height at zoom %s', (scale) => {
    const observers = resizeObservers()
    const b = mount()
    b.geometry.scale = scale
    act(observers[0]!.notify)
    expect(b.tools.style.height).toBe('520px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('520px')
  })

  it('observes only a ready active thread and releases its height when hidden or loading', () => {
    const observers = resizeObservers()
    const b = mount(false, false)
    expect(observers).toHaveLength(0)
    b.update(true, false)
    expect(observers).toHaveLength(0)
    b.update(true, true)
    expect(b.tools.style.height).toBe('520px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('520px')
    b.update(false, true)
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce()
    expect(b.tools.style.height).toBe('')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('')
    expect(b.layoutChanged).toHaveBeenCalledTimes(2)
    act(observers[0]!.notify)
    expect(b.tools.style.height).toBe('')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('')
    expect(b.layoutChanged).toHaveBeenCalledTimes(2)
    b.update(true, true)
    expect(b.tools.style.height).toBe('520px')
    b.update(true, false)
    expect(observers[1]!.disconnect).toHaveBeenCalledOnce()
    expect(b.tools.style.height).toBe('')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('')
    expect(b.layoutChanged).toHaveBeenCalledTimes(4)
  })

  it('ignores retired observers and clears only its own last height on unmount', () => {
    const observers = resizeObservers()
    const b = mount()
    act(observers[0]!.notify)
    b.update(false, true)
    b.geometry.scroll = 600
    b.update(true, true)
    expect(b.tools.style.height).toBe('640px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('640px')
    b.geometry.scroll = 700
    act(observers[0]!.notify)
    expect(b.tools.style.height).toBe('640px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('640px')
    expect(b.layoutChanged).toHaveBeenCalledTimes(3)
    b.unmount()
    expect(observers[1]!.disconnect).toHaveBeenCalledOnce()
    expect(b.tools.style.height).toBe('')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('')
    expect(b.layoutChanged).toHaveBeenCalledTimes(4)
    act(observers[1]!.notify)
    expect(b.tools.style.height).toBe('')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('')
    expect(b.layoutChanged).toHaveBeenCalledTimes(4)
  })

  it('keeps separate thread hosts and their observers independent', () => {
    const observers = resizeObservers()
    const first = mount()
    const second = mount()
    second.geometry.scroll = 300
    act(() => { observers[0]!.notify(); observers[1]!.notify() })
    expect(first.tools.style.height).toBe('520px')
    expect(second.tools.style.height).toBe('340px')
    expect(first.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('520px')
    expect(second.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('340px')
    first.update(false, true)
    first.geometry.scroll = 900
    act(observers[0]!.notify)
    expect(first.tools.style.height).toBe('')
    expect(second.tools.style.height).toBe('340px')
    expect(first.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('')
    expect(second.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('340px')
    first.unmount()
    expect(observers[1]!.disconnect).not.toHaveBeenCalled()
  })

  it('preserves a height replaced by another owner before cleanup', () => {
    const observers = resizeObservers()
    const b = mount()
    act(observers[0]!.notify)
    b.tools.style.height = '800px'
    b.chat.style.setProperty(CARD_HEIGHT_PROPERTY, '900px')
    b.unmount()
    expect(b.tools.style.height).toBe('800px')
    expect(b.chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)).toBe('900px')
    expect(b.layoutChanged).toHaveBeenCalledOnce()
  })

  it('clears its own height when CSSOM serializes the measurement differently', () => {
    const observers = resizeObservers()
    const b = mount()
    // Equivalent serialization avoids depending on an engine's floating-point formatting.
    vi.spyOn(b.tools.style, 'height', 'get').mockReturnValue('520.0px')
    const readProperty = b.chat.style.getPropertyValue.bind(b.chat.style)
    vi.spyOn(b.chat.style, 'getPropertyValue').mockImplementation(name =>
      name === CARD_HEIGHT_PROPERTY ? '520.0px' : readProperty(name))
    act(observers[0]!.notify)
    expect(b.tools.style.getPropertyValue('height')).toBe('520px')
    expect(readProperty(CARD_HEIGHT_PROPERTY)).toBe('520px')
    b.unmount()
    expect(b.tools.style.getPropertyValue('height')).toBe('')
    expect(readProperty(CARD_HEIGHT_PROPERTY)).toBe('')
  })

  it('uses the latest geometry callback without replacing its observer', () => {
    const observers = resizeObservers()
    const b = mount()
    act(observers[0]!.notify)
    const nextLayoutChanged = vi.fn<() => void>()
    b.update(true, true, nextLayoutChanged)
    expect(observers).toHaveLength(1)
    b.geometry.scroll = 600
    act(observers[0]!.notify)
    expect(b.layoutChanged).toHaveBeenCalledOnce()
    expect(nextLayoutChanged).toHaveBeenCalledOnce()
    b.unmount()
    expect(nextLayoutChanged).toHaveBeenCalledTimes(2)
  })
})
