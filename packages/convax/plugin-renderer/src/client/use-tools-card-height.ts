/** Align one thread's tools and graph ports with its native transcript card. */
import { useLayoutEffect, useRef, type RefObject } from 'react'

const CARD_HEIGHT_PROPERTY = '--dsh-convax-chat-card-height'

/**
 * Publish the transcript card's unscaled height before paint, excluding the composer.
 * The body reserves the transcript height until its native slot is attached.
 * @param bodyRef - Thread-owned body containing the native transcript scrollport.
 * @param toolsRef - Thread-owned tool host receiving the measured inline height.
 * @param active - Whether this thread is selected and its Chat is expanded.
 * @param ready - Whether the retained Session is available for the native Conversation.
 * @param layoutChanged - Notify the canvas after published handle geometry changes.
 * @returns No value; deactivation releases the observer and its owned heights.
 */
export function useToolsCardHeight(
  bodyRef: RefObject<HTMLDivElement | null>,
  toolsRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  ready: boolean,
  layoutChanged: () => void,
): void {
  const notifyLayout = useRef(layoutChanged)
  notifyLayout.current = layoutChanged
  useLayoutEffect(() => {
    if (!active || !ready) return
    const body = bodyRef.current
    const tools = toolsRef.current
    const chat = body?.closest<HTMLElement>('[data-convax-chat]')
    const header = chat?.querySelector<HTMLElement>('[data-convax-chat-header]')
    if (body === null || tools === null || chat == null || header == null) return
    let disposed = false
    let lastMeasuredHeight: string | undefined
    let lastWrittenHeight: string | undefined
    let lastWrittenCardHeight: string | undefined
    const measure = (): void => {
      if (disposed || bodyRef.current !== body || toolsRef.current !== tools) return
      const rect = body.getBoundingClientRect()
      if (body.offsetWidth === 0 || rect.width === 0) return
      const scale = rect.width / body.offsetWidth
      const transcript = body.querySelector<HTMLElement>('[data-conversation-scroll]') ?? body
      const height = `${(transcript.getBoundingClientRect().bottom - chat.getBoundingClientRect().top) / scale}px`
      if (height === lastMeasuredHeight) return
      tools.style.height = height
      chat.style.setProperty(CARD_HEIGHT_PROPERTY, height)
      lastMeasuredHeight = height
      lastWrittenHeight = tools.style.height
      lastWrittenCardHeight = chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY)
      notifyLayout.current()
    }
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    observer.observe(header)
    measure()
    return () => {
      disposed = true
      observer.disconnect()
      if (lastWrittenHeight !== undefined && tools.style.height === lastWrittenHeight) tools.style.removeProperty('height')
      if (lastWrittenCardHeight !== undefined && chat.style.getPropertyValue(CARD_HEIGHT_PROPERTY) === lastWrittenCardHeight) {
        chat.style.removeProperty(CARD_HEIGHT_PROPERTY)
        notifyLayout.current()
      }
    }
  }, [bodyRef, toolsRef, active, ready])
}
