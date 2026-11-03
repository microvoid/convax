/** Pointer-captured right-edge resizing in an embedding workspace's coordinate system. */
import { useEffect, useRef, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { FLOAT_MIN_SIZE } from '@deepseek-ai/dsh-client-ui-dockkit'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EmbeddedSidebarResize } from '../contract/slots.ts'
import css from './SidebarRight.module.css'

interface Gesture {
  readonly pointerId: number
  readonly element: HTMLButtonElement
  readonly x: number
  readonly scale: number
  readonly width: number
  readonly sessionId: SessionId
  readonly fullscreen: boolean
}

/** Inputs for a mounted resize control whose containing panel is expanded and active. */
export interface EmbeddedSidebarResizeHandleProps {
  readonly container: RefObject<HTMLDivElement | null>
  readonly sessionId: SessionId
  readonly fullscreen: boolean
  readonly resize: EmbeddedSidebarResize
  /** @param width - local width preview, or null to restore the containing workspace's width. */
  readonly preview: (width: number | null) => void
}

/**
 * Resize the embedded companion without changing its retained tool pages.
 * @param props - Live panel container, Session, mode, localized controls and preview writer.
 * @returns A right-edge grip whose cancellation never commits a width.
 */
export function EmbeddedSidebarResizeHandle({ container, sessionId, fullscreen, resize, preview }: EmbeddedSidebarResizeHandleProps) {
  const gesture = useRef<Gesture | null>(null)
  const controls = useRef({ resize, preview })
  controls.current = { resize, preview }
  useEffect(() => () => {
    const active = gesture.current
    gesture.current = null
    if (active === null) return
    controls.current.preview(null)
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
  }, [sessionId, fullscreen])

  const read = (): { width: number; scale: number } | null => {
    const root = container.current
    if (root === null || root.offsetWidth === 0) return null
    const rect = root.getBoundingClientRect()
    if (rect.width === 0) return null
    return { width: root.offsetWidth, scale: rect.width / root.offsetWidth }
  }
  const end = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean): void => {
    const active = gesture.current
    if (active === null || active.pointerId !== event.pointerId) return
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(active.pointerId)) event.currentTarget.releasePointerCapture(active.pointerId)
    controls.current.preview(null)
    if (commit && active.sessionId === sessionId && active.fullscreen === fullscreen && event.clientX !== active.x) {
      controls.current.resize.onCommit(Math.max(FLOAT_MIN_SIZE.width, active.width + (event.clientX - active.x) / active.scale), fullscreen)
    }
  }
  return <Tooltip label={resize.help} portal>
    <button type="button" className={`${css.embeddedResize} nodrag nopan nowheel`} aria-label={resize.label}
      data-sidebar-right-resize=""
      onPointerDown={(event) => {
        if (event.button !== 0 || gesture.current !== null) return
        const current = read()
        if (current === null) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        gesture.current = { ...current, pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, sessionId, fullscreen }
      }}
      onPointerMove={(event) => {
        const active = gesture.current
        if (active === null || active.pointerId !== event.pointerId) return
        if (active.sessionId !== sessionId || active.fullscreen !== fullscreen) { end(event, false); return }
        event.preventDefault()
        event.stopPropagation()
        controls.current.preview(Math.max(FLOAT_MIN_SIZE.width, active.width + (event.clientX - active.x) / active.scale))
      }}
      onPointerUp={(event) => { end(event, true) }}
      onPointerCancel={(event) => { end(event, false) }}
      onLostPointerCapture={(event) => { end(event, false) }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const current = read()
        if (current === null) return
        event.preventDefault()
        event.stopPropagation()
        const step = 10 * (event.key === 'ArrowLeft' ? -1 : 1)
        controls.current.resize.onCommit(Math.max(FLOAT_MIN_SIZE.width, current.width + step), fullscreen)
      }} />
  </Tooltip>
}
