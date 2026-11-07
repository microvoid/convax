/** Browser cards reuse the registered DSH browser Factory with canvas-owned instances. */
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Globe } from 'lucide-react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasId, CanvasNodeId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasNodeOwner, CanvasNodeRendererProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { CardResizeHandle, CardToolbar, NodePorts, resizeResource, type ResourceSize } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserViewId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import css from './NodeCard.module.css'
import browserCss from './BrowserNode.module.css'

/** The card asks its window owner to retain a browser without taking ownership itself. */
export interface BrowserCardInjected {
  readonly ensureBrowser: (canvasId: CanvasId, nodeId: CanvasNodeId) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Canvas card surrounding the independent native browser content. */
    'convax.browser.content': { scope: 'root'; props: CanvasNodeOwner; locale: 'convax'; inject: BrowserCardInjected }
  }
}

/** Browser card Factory props, including its narrow owner callbacks. */
export type BrowserCardProps = FactoryComponentPropsOf<'convax.browser.content'>

/** Dispatch the card Factory. @param props - Graph-owned node. @returns injected browser card. */
export function BrowserNode(props: CanvasNodeRendererProps) {
  return props.renderFactorySlot('convax.browser.content', {
    active: props.active, node: props.node, canvasId: props.canvasId, canvasRevision: props.canvasRevision,
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

/**
 * Retain collapsed browser content.
 * @param props - Graph fields and browser registration callback.
 * @returns browser card with native content.
 */
export function BrowserCard(props: BrowserCardProps) {
  const { node, t, selected, busy } = props
  const name = typeof node.data.title === 'string' ? node.data.title : t('browser.title')
  const contentsId = useId()
  const card = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<ResourceSize | null>(null)
  const size = { width: props.resourcePreviewWidth ?? 640, height: props.resourcePreviewHeight ?? 440 }
  const expanded = props.resourceExpanded
  useEffect(() => { props.ensureBrowser(props.canvasId, node.id) }, [props.ensureBrowser, props.canvasId, node.id])
  return <article ref={card} className={`${css.node} ${css.resourceNode} ${browserCss.node}`}
    style={{ width: preview?.width ?? size.width }} data-selected={selected || undefined}
    data-convax-browser={node.id} data-expanded={expanded || undefined}>
    <CardToolbar nodeId={node.id} name={name} t={t} actions={[
      { id: 'zoom', label: t('node.focus'), onClick: props.focusNode },
      { id: 'remove', label: t('files.reference'), disabled: busy, onClick: props.remove },
    ]} />
    <NodePorts nodeId={node.id} ports={props.ports} connectable={!busy} />
    <div className={css.resourceHeader} data-convax-browser-header="">
      <div className={css.resourceHeading}>
        <Tooltip label={t(expanded ? 'files.collapse' : 'files.expand', { name })} side="bottom" portal>
          <Button size="sm" className={`${css.resourceToggle} nodrag nopan`} aria-expanded={expanded} aria-controls={contentsId}
            aria-label={t(expanded ? 'files.collapse' : 'files.expand', { name })}
            onClick={() => { setPreview(null); props.setResourceExpanded(!expanded) }}>
            {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </Button>
        </Tooltip>
        <Globe size={16} aria-hidden />
        <div className={css.resourceIdentity}><Tooltip label={name} side="bottom" portal><span className={css.nodeTitle}>{name}</span></Tooltip></div>
      </div>
    </div>
    <div ref={body} id={contentsId} className={`${browserCss.body} nodrag nopan nowheel`} hidden={!expanded}
      style={{ height: preview?.height ?? size.height }} data-convax-browser-preview="" data-convax-input-owner="">
      {props.renderFactorySlot('browser.content', { browserId: String(node.id) as BrowserViewId, active: props.active && expanded,
        ...(typeof node.data.url === 'string' ? { initialUrl: node.data.url } : {}) })}
    </div>
    <CardResizeHandle container={card} content={body} size={size} collapsed={!expanded} resize={resizeResource}
      preview={setPreview} commit={props.setResourcePreviewSize}
      label={t('files.preview.resize')} help={t('files.preview.resizeHelp')} />
  </article>
}
