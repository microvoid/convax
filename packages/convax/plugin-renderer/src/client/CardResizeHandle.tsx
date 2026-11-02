/** Pointer-captured resizing shared by canvas resource cards. */
import { useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ResourceSize } from './resource-size.ts'
import css from './NodeCard.module.css'

interface CardResizeHandleProps {
  readonly container: RefObject<HTMLElement | null>
  readonly content: RefObject<HTMLElement | null>
  readonly size: ResourceSize
  readonly collapsed: boolean
  readonly resize: (start: ResourceSize, dx: number, dy: number, scale: number) => ResourceSize
  readonly preview: (size: ResourceSize | null) => void
  readonly commit: (size: ResourceSize) => void
  readonly label: string
  readonly help: string
}

interface ResizeGesture {
  readonly pointerId: number
  readonly element: HTMLButtonElement
  readonly x: number
  readonly y: number
  readonly scale: number
  readonly size: ResourceSize
  readonly collapsed: boolean
}

/**
 * Resize a card from its outer corner without replacing its contents.
 * @param props - Card measurements, saved dimensions, and gesture-owned size actions.
 * @returns A keyboard-accessible grip that preserves expanded height while collapsed.
 */
export function CardResizeHandle(props: CardResizeHandleProps) {
  const gesture = useRef<ResizeGesture | null>(null)
  const controls = useRef(props)
  controls.current = props
  const [resizing, setResizing] = useState(false)
  useEffect(() => () => {
    const active = gesture.current
    gesture.current = null
    if (active === null) return
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
    controls.current.preview(null)
  }, [])

  const cancel = (): void => {
    const active = gesture.current
    if (active === null) return
    gesture.current = null
    setResizing(false)
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
    controls.current.preview(null)
  }
  const nextSize = (active: ResizeGesture, x: number, y: number): ResourceSize => {
    const next = props.resize(active.size, x - active.x, active.collapsed ? 0 : y - active.y, active.scale)
    return active.collapsed ? { ...next, height: active.size.height } : next
  }
  const end = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean): void => {
    const active = gesture.current
    if (active === null || active.pointerId !== event.pointerId) return
    const next = nextSize(active, event.clientX, event.clientY)
    cancel()
    if (commit && (next.width !== active.size.width || next.height !== active.size.height)) props.commit(next)
  }

  return <Tooltip label={props.help} portal>
    <button type="button" className={`${css.previewResize} nodrag nopan nowheel`} aria-label={props.label}
      data-convax-resource-resize="" data-resizing={resizing || undefined}
      onPointerDown={(event) => {
        const root = props.container.current
        if (event.button !== 0 || gesture.current !== null || root === null || root.offsetWidth <= 0) return
        const bounds = root.getBoundingClientRect()
        if (bounds.width <= 0) return
        const contentHeight = props.content.current?.offsetHeight
        const height = props.collapsed || contentHeight === undefined || contentHeight <= 0 ? props.size.height : contentHeight
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        gesture.current = {
          pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY,
          scale: bounds.width / root.offsetWidth, size: { width: root.offsetWidth, height }, collapsed: props.collapsed,
        }
        setResizing(true)
      }}
      onPointerMove={(event) => {
        const active = gesture.current
        if (active === null || active.pointerId !== event.pointerId) return
        event.preventDefault()
        event.stopPropagation()
        props.preview(nextSize(active, event.clientX, event.clientY))
      }}
      onPointerUp={(event) => { end(event, true) }}
      onPointerCancel={(event) => { end(event, false) }}
      onLostPointerCapture={(event) => { end(event, false) }}
      onBlur={cancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && gesture.current !== null) {
          event.preventDefault()
          event.stopPropagation()
          cancel()
          return
        }
        if (gesture.current !== null || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
        const changes: Record<string, readonly [number, number]> = {
          ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10],
        }
        const change = changes[event.key]
        if (change === undefined) return
        event.preventDefault()
        event.stopPropagation()
        const resized = props.resize(props.size, change[0], props.collapsed ? 0 : change[1], 1)
        const next = props.collapsed ? { ...resized, height: props.size.height } : resized
        if (next.width !== props.size.width || next.height !== props.size.height) props.commit(next)
      }} />
  </Tooltip>
}
