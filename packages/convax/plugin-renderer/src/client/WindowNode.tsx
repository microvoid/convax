/** Read-only window card shares resource-card layout and window-retained capture ownership. */
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AppWindow, ChevronDown, ChevronRight } from 'lucide-react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasWindowBindingId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasNodeRendererProps } from './props.ts'
import type { WindowMirrorProps } from './window-contract.ts'
import { CardToolbar } from './CardToolbar.tsx'
import { NodePorts } from './node-renderers.tsx'
import { RESOURCE_CARD_WIDTH } from './placement.ts'
import { resizeResource, type ResourceSize } from './resource-size.ts'
import css from './NodeCard.module.css'
import windowCss from './WindowNode.module.css'

/**
 * Dispatch only graph owner fields to the capture-injected Factory.
 * @param props - Graph-owned node occurrence.
 * @returns A capture-injected read-only window card.
 */
export function WindowNode(props: CanvasNodeRendererProps) {
  return props.renderFactorySlot('convax.window.content', {
    node: props.node, canvasId: props.canvasId, canvasRevision: props.canvasRevision,
    definition: props.definition, ports: props.ports, selected: props.selected, busy: props.busy, chat: props.chat,
    remove: props.remove, command: props.command, openResource: props.openResource, openSource: props.openSource,
    createChat: props.createChat, chooseWindow: props.chooseWindow, focusSessionId: props.focusSessionId,
    consumeFocus: props.consumeFocus, inputs: props.inputs, focusNode: props.focusNode,
    resourceExpanded: props.resourceExpanded, setResourceExpanded: props.setResourceExpanded,
    setResourcePreviewSize: props.setResourcePreviewSize,
    ...(props.resourcePreviewHeight === undefined ? {} : { resourcePreviewHeight: props.resourcePreviewHeight }),
    ...(props.resourcePreviewWidth === undefined ? {} : { resourcePreviewWidth: props.resourcePreviewWidth }),
  })
}

interface ResizeGesture {
  readonly pointerId: number
  readonly element: HTMLButtonElement
  readonly x: number
  readonly y: number
  readonly scale: number
  readonly size: ResourceSize
}

/**
 * Display a read-only source view with an explicit reconnect state.
 * @param props - Detached mirror status, native view callbacks, and graph actions.
 * @returns The window header, live image or reconnect state.
 */
export function WindowMirror(props: WindowMirrorProps) {
  const { node, ports, t, busy, selected } = props
  const bindingId = node.data.bindingId as CanvasWindowBindingId
  const name = typeof node.data.name === 'string' ? node.data.name : t('window.add')
  const status = props.useWindowMirrors(state => state[bindingId])
  const live = status?.nodeId === node.id && status.status === 'live'
  const viewportId = useId()
  const contentsId = useId()
  const card = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const gesture = useRef<ResizeGesture | null>(null)
  const [preview, setPreview] = useState<ResourceSize | null>(null)
  const width = props.resourcePreviewWidth ?? Math.max(RESOURCE_CARD_WIDTH, 480)
  const size = { width, height: props.resourcePreviewHeight ?? 270 }
  const expanded = props.resourceExpanded
  useEffect(() => {
    if (!expanded || !live) return
    return props.mountWindow(node.id, bindingId, viewportId)
  }, [expanded, live, props.mountWindow, node.id, bindingId, viewportId])
  useEffect(() => {
    if (!live) return
    const check = (): void => { if (document.visibilityState === 'visible') void props.validateWindow(node.id, bindingId) }
    check()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => { window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check) }
  }, [live, props.validateWindow, node.id, bindingId])
  const cancelResize = (): void => {
    const active = gesture.current
    gesture.current = null
    setPreview(null)
    if (active?.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
  }
  useEffect(() => () => {
    const active = gesture.current
    gesture.current = null
    if (active?.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId)
  }, [])
  const end = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean): void => {
    const active = gesture.current
    if (active?.pointerId !== event.pointerId) return
    cancelResize()
    if (commit) props.setResourcePreviewSize(resizeResource(active.size, event.clientX - active.x, event.clientY - active.y, active.scale))
  }
  return <article ref={card} className={`${css.node} ${css.resourceNode} ${windowCss.node}`}
    style={{ width: preview?.width ?? size.width }} data-selected={selected || undefined}
    data-convax-window={node.id} data-expanded={expanded || undefined}>
    <CardToolbar nodeId={node.id} name={name} t={t} actions={[
      { id: 'zoom', label: t('node.focus'), onClick: props.focusNode },
      { id: 'window', label: t('window.rebind'), disabled: busy || props.chooseWindow === undefined,
        onClick: () => { props.chooseWindow?.(node.id) } },
      { id: 'chat', label: t('chat.new'), disabled: busy, onClick: () => { props.createChat(undefined, node.id) } },
      { id: 'remove', label: t('files.reference'), disabled: busy, onClick: props.remove },
    ]} />
    <NodePorts nodeId={node.id} ports={ports} connectable={!busy} />
    <div className={css.resourceHeader} data-convax-window-header="">
      <div className={css.resourceHeading}>
        <Tooltip label={t(expanded ? 'files.collapse' : 'files.expand', { name })} portal>
          <Button size="sm" className={`${css.resourceToggle} nodrag nopan`} aria-expanded={expanded} aria-controls={contentsId}
            aria-label={t(expanded ? 'files.collapse' : 'files.expand', { name })} onClick={() => { cancelResize(); props.setResourceExpanded(!expanded) }}>
            {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </Button>
        </Tooltip>
        <AppWindow size={16} aria-hidden />
        <div className={css.resourceIdentity}><Tooltip label={name} portal><span className={css.nodeTitle}>{name}</span></Tooltip></div>
        <span className={css.resourceMeta}>{t('window.readOnly')}</span>
      </div>
    </div>
    {expanded && <div ref={body} id={contentsId} className={`${css.resourcePreview} ${windowCss.body} nodrag nopan nowheel`}
      style={{ height: preview?.height ?? size.height }} data-convax-window-preview=""
      onPointerEnter={() => { if (live) void props.validateWindow(node.id, bindingId) }}>
      {live ? <div id={viewportId} className={windowCss.viewport} /> : <div className={windowCss.disconnected} role="status">
        <AppWindow size={28} aria-hidden /><p>{t(props.chooseWindow === undefined ? 'window.unavailable' : 'window.disconnected')}</p>
        {props.chooseWindow !== undefined && <Button size="sm" disabled={busy}
          onClick={() => { props.chooseWindow?.(node.id) }}>{t('window.rebind')}</Button>}
      </div>}
      <Tooltip label={t('files.preview.resizeHelp')} portal><button type="button" className={`${css.previewResize} nodrag nopan nowheel`}
        aria-label={t('files.preview.resize')} data-convax-resource-resize="" data-resizing={preview !== null || undefined}
        onPointerDown={(event) => {
          const root = card.current
          if (event.button !== 0 || root === null || body.current === null || root.offsetWidth === 0 || gesture.current !== null) return
          event.preventDefault(); event.stopPropagation()
          event.currentTarget.setPointerCapture(event.pointerId)
          gesture.current = { pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY,
            scale: root.getBoundingClientRect().width / root.offsetWidth,
            size: { width: root.offsetWidth, height: body.current.offsetHeight } }
        }}
        onPointerMove={(event) => {
          const active = gesture.current
          if (active?.pointerId !== event.pointerId) return
          event.preventDefault(); event.stopPropagation()
          setPreview(resizeResource(active.size, event.clientX - active.x, event.clientY - active.y, active.scale))
        }} onPointerUp={(event) => { end(event, true) }} onPointerCancel={(event) => { end(event, false) }}
        onLostPointerCapture={(event) => { end(event, false) }} onBlur={cancelResize}
        onKeyDown={(event) => {
          const changes: Record<string, readonly [number, number]> = {
            ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10],
          }
          const change = changes[event.key]
          if (change === undefined) return
          event.preventDefault(); event.stopPropagation()
          props.setResourcePreviewSize(resizeResource(size, change[0], change[1], 1))
        }} /></Tooltip>
    </div>}
  </article>
}
