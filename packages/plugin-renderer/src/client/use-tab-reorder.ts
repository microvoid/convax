/** Local pointer and keyboard sorting for canvas and Chat thread tab strips. */
import { useEffect, useRef, useState, type AnimationEvent, type ButtonHTMLAttributes, type CSSProperties, type PointerEvent, type RefObject } from 'react'

interface TabBox<Id extends string> {
  readonly id: Id
  readonly left: number
  readonly width: number
}

interface TabPreview<Id extends string> {
  readonly layout: string
  readonly id: Id
  readonly offsets: Readonly<Record<string, number>>
  readonly offset: number
  readonly target: { id: Id; side: 'before' | 'after' } | null
  readonly settleOffset: number
}

interface TabGesture<Id extends string> {
  readonly layout: string
  readonly id: Id
  readonly pointerId: number
  readonly element: HTMLButtonElement
  readonly strip: HTMLDivElement
  readonly boxes: readonly TabBox<Id>[]
  readonly source: TabBox<Id>
  readonly startX: number
  readonly grabOffset: number
  readonly scale: number
  readonly gap: number
  x: number
  started: boolean
  preview: TabPreview<Id> | null
  frame?: number
  timestamp?: number
}

function preview<Id extends string>(gesture: TabGesture<Id>): TabPreview<Id> {
  const { boxes, source, strip } = gesture
  const rect = strip.getBoundingClientRect()
  const left = Math.max(0, Math.min((gesture.x - rect.left) / gesture.scale - gesture.grabOffset,
    rect.width / gesture.scale - source.width))
  const offset = left + strip.scrollLeft - source.left
  const from = boxes.indexOf(source)
  let to = from
  for (const [index, box] of boxes.entries()) {
    const midpoint = box.left + box.width / 2
    if (index < from && source.left + offset < midpoint) to = Math.min(to, index)
    if (index > from && source.left + source.width + offset > midpoint) to = Math.max(to, index)
  }
  const offsets: Record<string, number> = { [source.id]: offset }
  let destination = source
  for (const [index, box] of boxes.entries()) {
    if (index === to) destination = box
    if (from < index && index <= to) offsets[box.id] = -(source.width + gesture.gap)
    else if (to <= index && index < from) offsets[box.id] = source.width + gesture.gap
  }
  const destinationLeft = to > from ? destination.left + destination.width - source.width : destination.left
  return {
    id: source.id, layout: gesture.layout, offsets, offset,
    target: to === from ? null : { id: destination.id, side: to < from ? 'before' : 'after' },
    settleOffset: source.left + offset - destinationLeft,
  }
}

function scrollSpeed<Id extends string>(gesture: TabGesture<Id>): number {
  const rect = gesture.strip.getBoundingClientRect()
  const edge = Math.min(32 * gesture.scale, rect.width / 4)
  const direction = gesture.x < rect.left + edge ? -Math.min(1, (rect.left + edge - gesture.x) / edge)
    : gesture.x > rect.right - edge ? Math.min(1, (gesture.x - rect.right + edge) / edge) : 0
  if (direction < 0 && gesture.strip.scrollLeft <= 0) return 0
  if (direction > 0 && gesture.strip.scrollLeft + gesture.strip.clientWidth >= gesture.strip.scrollWidth) return 0
  return direction * 600
}

function release<Id extends string>(gesture: TabGesture<Id>): void {
  if (gesture.frame !== undefined) cancelAnimationFrame(gesture.frame)
  if (gesture.element.hasPointerCapture(gesture.pointerId)) gesture.element.releasePointerCapture(gesture.pointerId)
}

function scaleOf(element: HTMLElement): number {
  const width = element.offsetWidth || element.clientWidth
  return width > 0 ? element.getBoundingClientRect().width / width : 1
}

/** Stable identities and titles used to invalidate an in-progress tab arrangement. */
export interface ReorderTab<Id extends string> {
  readonly id: Id
  readonly title: string
}

interface TabReorderActions<Id extends string> {
  strip: RefObject<HTMLDivElement>
  dragging: boolean
  item: (id: Id) => {
    'data-sortable-tab': Id
    'data-dragging': true | undefined
    'data-settling': true | undefined
    style: CSSProperties
    onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void
  }
  button: (id: Id) => ButtonHTMLAttributes<HTMLButtonElement>
}

/**
 * Preview horizontal tab movement and commit one saved insertion on release.
 * @param tabs - Current ordered tab identities and layout-affecting titles.
 * @param move - Persist one tab before or after another without changing selection.
 * @returns Strip ref, wrapper presentation and title-button gesture handlers.
 */
export function useTabReorder<Id extends string>(tabs: readonly ReorderTab<Id>[], move: (id: Id, target: Id, side: 'before' | 'after') => void): TabReorderActions<Id> {
  const strip = useRef<HTMLDivElement>(null)
  const gesture = useRef<TabGesture<Id> | null>(null)
  const suppressClick = useRef(false)
  const suppressRename = useRef(false)
  const restoreFocus = useRef<HTMLButtonElement | null>(null)
  const [pendingDrag, setDrag] = useState<TabPreview<Id> | null>(null)
  const [settling, setSettling] = useState<{ id: Id; offset: number } | null>(null)
  const layout = JSON.stringify(tabs.map(tab => [tab.id, tab.title]))
  const drag = pendingDrag?.layout === layout ? pendingDrag : null
  useEffect(() => {
    const focused = restoreFocus.current
    restoreFocus.current = null
    if (focused?.isConnected) {
      focused.focus({ preventScroll: true })
      const container = strip.current
      const tab = focused.closest<HTMLElement>('[data-sortable-tab]')
      if (container !== null && tab !== null) {
        const viewport = container.getBoundingClientRect()
        const rect = tab.getBoundingClientRect()
        if (rect.left < viewport.left) container.scrollLeft -= (viewport.left - rect.left) / scaleOf(container)
        else if (rect.right > viewport.right) container.scrollLeft += (rect.right - viewport.right) / scaleOf(container)
      }
    }
    const cancel = (): void => {
      const active = gesture.current
      if (active === null) return
      gesture.current = null
      release(active)
      suppressClick.current = active.started
      suppressRename.current = active.started
      setDrag(null)
      setSettling(null)
    }
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
      const active = gesture.current
      gesture.current = null
      if (active !== null) {
        suppressClick.current = active.started
        suppressRename.current = active.started
        release(active)
      }
    }
  }, [layout])

  const finish = (commit: boolean): void => {
    const active = gesture.current
    if (active === null) return
    gesture.current = null
    release(active)
    setDrag(null)
    if (!active.started || active.preview === null) return
    suppressClick.current = true
    suppressRename.current = true
    const target = commit ? active.preview.target : null
    setSettling({ id: active.id, offset: commit ? active.preview.settleOffset : active.preview.offset })
    if (target !== null) {
      restoreFocus.current = active.element
      move(active.id, target.id, target.side)
    }
  }
  const paint = (active: TabGesture<Id>): void => {
    active.preview = preview(active)
    setDrag(active.preview)
  }
  const scroll = (active: TabGesture<Id>): void => {
    if (active.frame !== undefined || scrollSpeed(active) === 0) return
    active.frame = requestAnimationFrame((timestamp) => {
      delete active.frame
      if (gesture.current !== active) return
      const speed = scrollSpeed(active)
      const elapsed = active.timestamp === undefined ? 1000 / 60 : Math.min(32, timestamp - active.timestamp)
      active.timestamp = timestamp
      const before = active.strip.scrollLeft
      active.strip.scrollLeft = Math.max(0, Math.min(active.strip.scrollWidth - active.strip.clientWidth,
        before + speed * elapsed / 1000))
      if (active.strip.scrollLeft === before) return
      paint(active)
      scroll(active)
    })
  }
  const begin = (event: PointerEvent<HTMLButtonElement>, id: Id): void => {
    if (event.button !== 0 || gesture.current !== null || strip.current === null) return
    const element = event.currentTarget
    const container = strip.current
    const rect = container.getBoundingClientRect()
    const scale = scaleOf(container)
    const elements = [...container.querySelectorAll<HTMLElement>('[data-sortable-tab]')]
    const boxes = tabs.flatMap((tab) => {
      const node = elements.find(node => node.dataset.sortableTab === tab.id)
      if (node === undefined) return []
      const box = node.getBoundingClientRect()
      return [{ id: tab.id, left: (box.left - rect.left) / scale + container.scrollLeft, width: box.width / scale }]
    })
    const source = boxes.find(box => box.id === id)
    if (source === undefined) return
    suppressClick.current = false
    suppressRename.current = false
    setSettling(null)
    gesture.current = {
      id, layout, pointerId: event.pointerId, element, strip: container, boxes, source,
      startX: event.clientX, x: event.clientX, scale,
      grabOffset: (event.clientX - rect.left) / scale - source.left + container.scrollLeft,
      gap: Number.parseFloat(getComputedStyle(container).columnGap) || 0, started: false, preview: null,
    }
    element.setPointerCapture(event.pointerId)
  }
  return {
    strip,
    dragging: drag !== null,
    item: (id: Id) => ({
      'data-sortable-tab': id,
      'data-dragging': id === drag?.id || undefined,
      'data-settling': id === settling?.id || undefined,
      style: {
        ...(drag === null ? {} : { '--dsh-convax-tab-offset': `${drag.offsets[id] ?? 0}px` }),
        ...(id === settling?.id ? { '--dsh-convax-tab-settle': `${settling.offset}px` } : {}),
      } as CSSProperties,
      onAnimationEnd: (event: AnimationEvent<HTMLElement>) => {
        if (event.target === event.currentTarget && settling?.id === id) setSettling(null)
      },
    }),
    button: (id: Id): ButtonHTMLAttributes<HTMLButtonElement> => ({
      'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
      onPointerDown: (event) => { begin(event, id) },
      onPointerMove: (event) => {
        const active = gesture.current
        if (active === null || active.pointerId !== event.pointerId) return
        if (!active.started && Math.abs(event.clientX - active.startX) < 6) return
        active.started = true
        active.x = event.clientX
        event.preventDefault()
        paint(active)
        if (scrollSpeed(active) === 0 && active.frame !== undefined) {
          cancelAnimationFrame(active.frame)
          delete active.frame
          delete active.timestamp
        }
        scroll(active)
      },
      onPointerUp: (event) => { if (gesture.current?.pointerId === event.pointerId) finish(true) },
      onPointerCancel: (event) => { if (gesture.current?.pointerId === event.pointerId) finish(false) },
      onLostPointerCapture: (event) => { if (gesture.current?.pointerId === event.pointerId) finish(false) },
      onKeyDown: (event) => {
        if (event.key === 'Escape' && gesture.current !== null) {
          event.preventDefault()
          finish(false)
          suppressClick.current = true
          suppressRename.current = true
          return
        }
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return
        const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
        if (direction === 0) return
        event.preventDefault()
        finish(false)
        setSettling(null)
        const neighbor = tabs[tabs.findIndex(tab => tab.id === id) + direction]
        if (neighbor !== undefined) {
          restoreFocus.current = event.currentTarget
          move(id, neighbor.id, direction < 0 ? 'before' : 'after')
        }
      },
      onClickCapture: (event) => {
        if (!suppressClick.current) return
        suppressClick.current = false
        if (event.detail > 0) { event.preventDefault(); event.stopPropagation() }
      },
      onDoubleClickCapture: (event) => {
        if (suppressRename.current) { event.preventDefault(); event.stopPropagation() }
      },
    }),
  }
}
