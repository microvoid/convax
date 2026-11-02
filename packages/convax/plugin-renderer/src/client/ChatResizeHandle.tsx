/** Pointer-captured resize grip outside the native transcript's lower-right corner. */
import { useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatResizeControls } from './props.ts'
import { resizeChat, type ChatSize } from './chat-size.ts'
import css from './ChatCard.module.css'

interface Gesture {
  readonly pointerId: number
  readonly element: HTMLButtonElement
  readonly x: number
  readonly y: number
  readonly scale: number
  readonly size: ChatSize
}

/**
 * Resize the Chat without replacing its native transcript or editor.
 * @param props - Native Conversation container, localized guidance and size actions.
 * @returns A keyboard-accessible grip outside the transcript's lower-right corner.
 */
export function ChatResizeHandle({ container, actions, label, help }: {
  readonly container: RefObject<HTMLDivElement | null>
  readonly actions: ChatResizeControls
  readonly label: string
  readonly help: string
}) {
  const [bottom, setBottom] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const gesture = useRef<Gesture | null>(null)
  const controls = useRef(actions)
  controls.current = actions
  useEffect(() => {
    const root = container.current
    const scroll = root?.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (root === null || scroll == null) return
    const place = (): void => {
      const rect = root.getBoundingClientRect()
      if (root.offsetWidth === 0 || rect.width === 0) return
      const scale = rect.width / root.offsetWidth
      setBottom((rect.bottom - scroll.getBoundingClientRect().bottom) / scale)
    }
    const observer = new ResizeObserver(place)
    observer.observe(root)
    observer.observe(scroll)
    place()
    return () => { observer.disconnect() }
  }, [container])
  useEffect(() => () => {
    const active = gesture.current
    gesture.current = null
    if (active !== null) {
      controls.current.preview(null)
      if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
    }
  }, [])

  const read = (): { size: ChatSize; scale: number } | null => {
    const root = container.current
    const scroll = root?.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (root === null || scroll == null || root.offsetWidth === 0) return null
    return { size: { width: root.offsetWidth, height: scroll.offsetHeight }, scale: root.getBoundingClientRect().width / root.offsetWidth }
  }
  const end = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean): void => {
    const active = gesture.current
    if (active === null || active.pointerId !== event.pointerId) return
    gesture.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    actions.preview(null)
    if (commit && (event.clientX !== active.x || event.clientY !== active.y)) {
      actions.commit(resizeChat(active.size, event.clientX - active.x, event.clientY - active.y, active.scale))
    }
  }
  return <Tooltip label={help} portal>
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
        gesture.current = { ...current, pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY }
        setResizing(true)
      }}
      onPointerMove={(event) => {
        const active = gesture.current
        if (active === null || active.pointerId !== event.pointerId) return
        event.preventDefault()
        event.stopPropagation()
        actions.preview(resizeChat(active.size, event.clientX - active.x, event.clientY - active.y, active.scale))
      }}
      onPointerUp={(event) => { end(event, true) }}
      onPointerCancel={(event) => { end(event, false) }}
      onLostPointerCapture={(event) => { end(event, false) }}
      onKeyDown={(event) => {
        const directions: Record<string, readonly [number, number]> = {
          ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
        }
        const direction = directions[event.key]
        if (direction === undefined) return
        const current = read()
        if (current === null) return
        event.preventDefault()
        event.stopPropagation()
        const step = 10
        actions.commit(resizeChat(current.size, direction[0] * step, direction[1] * step, 1))
      }} />
  </Tooltip>
}
