/** Pointer-captured resize grip outside the native transcript's lower-right corner. */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatResizeControls } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { resizeChat, type ChatSize } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import css from './ChatCard.module.css'

interface Gesture {
  readonly pointerId: number
  readonly element: HTMLButtonElement
  readonly x: number
  readonly y: number
  readonly scale: number
  readonly size: ChatSize
  readonly collapsedHeight: number | undefined
  readonly detach: () => void
}

/**
 * Resize the Chat without replacing its native transcript or editor.
 * @param props - Native Conversation container, localized guidance and size actions.
 * @returns A keyboard-accessible grip outside the transcript's lower-right corner.
 */
export function ChatResizeHandle({ container, actions, label, help, useContainer = false, collapsedHeight }: {
  readonly container: RefObject<HTMLDivElement | null>
  readonly actions: ChatResizeControls
  readonly label: string
  readonly help: string
  /** Loading and failure placeholders resize their container instead of a transcript. */
  readonly useContainer?: boolean
  /** A collapsed header changes width while retaining its expanded body height. */
  readonly collapsedHeight?: number
}) {
  const [bottom, setBottom] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  const controls = useRef(actions)
  controls.current = actions
  useEffect(() => {
    const root = container.current
    const scroll = useContainer ? root : root?.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (root === null || scroll == null) return
    const place = (): void => {
      const rect = root.getBoundingClientRect()
      if (root.offsetWidth === 0 || rect.width === 0) return
      const scale = rect.width / root.offsetWidth
      setBottom((rect.bottom - scroll.getBoundingClientRect().bottom) / scale)
    }
    const observer = new ResizeObserver(place)
    observer.observe(root)
    if (scroll !== root) observer.observe(scroll)
    place()
    return () => { observer.disconnect() }
  }, [container, useContainer])
  useEffect(() => () => {
    const active = gesture.current
    gesture.current = null
    if (active !== null) {
      active.detach()
      controls.current.preview(null)
      if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
    }
  }, [])

  const read = (): { size: ChatSize; scale: number } | null => {
    const root = container.current
    const scroll = useContainer ? root : root?.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (root === null || scroll == null || root.offsetWidth === 0) return null
    const scale = root.getBoundingClientRect().width / root.offsetWidth
    if (scale <= 0) return null
    return { size: { width: root.offsetWidth, height: collapsedHeight ?? scroll.offsetHeight }, scale }
  }
  const resize = (active: Gesture, x: number, y: number): ChatSize =>
    resizeChat(active.size, x - active.x, active.collapsedHeight === undefined ? y - active.y : 0, active.scale)
  const cancel = (): void => {
    const active = gesture.current
    if (active === null) return
    gesture.current = null
    setResizing(false)
    active.detach()
    controls.current.preview(null)
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
  }
  const end = (event: PointerEvent, commit: boolean): void => {
    const active = gesture.current
    if (active === null || active.pointerId !== event.pointerId) return
    cancel()
    const next = resize(active, event.clientX, event.clientY)
    if (commit && (next.width !== active.size.width || next.height !== active.size.height)) {
      controls.current.commit(next)
    }
  }
  return <Tooltip label={help} side="top" portal>
    <button type="button" className={`${css.chatResize} nodrag nopan nowheel`} aria-label={label}
      data-convax-chat-resize="" data-resizing={resizing || undefined} hidden={bottom === null} style={{ bottom: bottom ?? 0 }}
      onPointerDown={(event) => {
        if (event.button !== 0 || gesture.current !== null) return
        const current = read()
        if (current === null) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        const owner = event.currentTarget.ownerDocument
        const ownerWindow = owner.defaultView
        const move = (event: PointerEvent): void => {
          const active = gesture.current
          if (active === null || active.pointerId !== event.pointerId) return
          event.preventDefault()
          event.stopPropagation()
          controls.current.preview(resize(active, event.clientX, event.clientY))
        }
        const up = (event: PointerEvent): void => { end(event, true) }
        const abort = (event: PointerEvent): void => { end(event, false) }
        // Capture may be released before pointerup; the document still owns the gesture.
        owner.addEventListener('pointermove', move, true)
        owner.addEventListener('pointerup', up, true)
        owner.addEventListener('pointercancel', abort, true)
        ownerWindow?.addEventListener('blur', cancel)
        gesture.current = {
          ...current, pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY, collapsedHeight,
          detach: () => {
            owner.removeEventListener('pointermove', move, true)
            owner.removeEventListener('pointerup', up, true)
            owner.removeEventListener('pointercancel', abort, true)
            ownerWindow?.removeEventListener('blur', cancel)
          },
        }
        setResizing(true)
      }}
      onBlur={cancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && gesture.current !== null) {
          cancel()
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (gesture.current !== null || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
        const directions: Record<string, readonly [number, number]> = {
          ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
        }
        const direction = directions[event.key]
        if (direction === undefined) return
        if (collapsedHeight !== undefined && direction[0] === 0) return
        const current = read()
        if (current === null) return
        event.preventDefault()
        event.stopPropagation()
        const step = 10
        actions.commit(resizeChat(current.size, direction[0] * step, direction[1] * step, 1))
      }} />
  </Tooltip>
}
