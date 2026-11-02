/** Versioned Client node displays registered independently of Host providers. */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { FileIcon } from './FileIcon.tsx'
import { Service, type Context } from '@deepseek-ai/cordis'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { Button, fileSizeText, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasPort } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasNodeOwner, CanvasNodeRendererProps, WorkspaceProps } from './props.ts'
import { NS } from './locales.ts'
import { RESOURCE_CARD_WIDTH } from './placement.ts'
import { ResourceDirectory } from './ResourceDirectory.tsx'
import { ResourcePreview } from './ResourcePreview.tsx'
import { CardToolbar } from './CardToolbar.tsx'
import { CardResizeHandle } from './CardResizeHandle.tsx'
import { resourceAddress } from './resources.ts'
import { mediaKind } from './media-kind.ts'
import { AUDIO_PREVIEW_HEIGHT, resizeResource, RESOURCE_MIN_PREVIEW_HEIGHT, RESOURCE_PREVIEW_HEIGHT, type ResourceSize } from './resource-size.ts'
import css from './NodeCard.module.css'

/** Supported payload version and its framework-composed display. */
export interface CanvasNodeRendererDefinition {
  /** Exact payload version this display understands. */
  dataVersion: number
  /** Use a registered Factory for additional stores, localization or child slots. */
  component: SlotComponent<CanvasNodeRendererProps>
}

/** Client-only registration independent of the node's Host capabilities. */
export interface IConvaxRenderer {
  /**
   * Register one node display for the contributing plugin's lifetime.
   * @param typeId - Stable provider-qualified Host node type identity.
   * @param definition - Exact data version and display component.
   * @returns Idempotent disposer; removing a display preserves saved node data and Host behavior.
   * @throws When another active display owns this identity.
   */
  registerNodeRenderer(typeId: CanvasNodeTypeId, definition: CanvasNodeRendererDefinition): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Versioned Convax node display registrations. */
    convaxRenderer: IConvaxRenderer
  }
}

/** Why the saved node cannot currently show its business UI. */
export type NodePlaceholderReason = 'provider' | 'renderer' | 'rendererVersion' | 'migrating' | 'incompatible'

/** Presentation-only state of a retained node. */
export interface NodePlaceholderProps extends Pick<CanvasNodeOwner, 'resourcePreviewWidth' | 'resourcePreviewHeight' | 'setResourcePreviewSize'> {
  node: CanvasNode
  ports: readonly CanvasPort[]
  reason: NodePlaceholderReason
  selected: boolean
  remove: () => void
  t: WorkspaceProps['t']
  detail?: string | undefined
}

/**
 * Render stable named endpoints, including those retained from an unavailable provider.
 * @param props - Declared or retained ports and whether new connections are allowed.
 * @returns React Flow handles at evenly spaced positions on each side.
 */
export function NodePorts({ nodeId, ports, connectable }: { nodeId: CanvasNodeId; ports: readonly CanvasPort[]; connectable: boolean }) {
  const updateNodeInternals = useUpdateNodeInternals()
  const endpoints = JSON.stringify(ports.map(port => [port.direction, port.id]))
  useLayoutEffect(() => { updateNodeInternals(nodeId) }, [nodeId, endpoints, updateNodeInternals])
  return <>{(['input', 'output'] as const).flatMap((direction) => {
    const group = ports.filter(port => port.direction === direction)
    return group.map((port, index) => <Handle key={`${direction}:${port.id}`}
      id={port.id} type={direction === 'input' ? 'target' : 'source'}
      position={direction === 'input' ? Position.Left : Position.Right}
      isConnectable={connectable} className={css.handle}
      style={{ top: `${(index + 1) * 100 / (group.length + 1)}%` }} />)
  })}</>
}

/**
 * Keep movement, deletion and existing relationships available without reading provider payloads.
 * @param props - Saved node identity and the reason its business display is unavailable.
 * @returns A localized placeholder with the node's original connection endpoints.
 */
export function NodePlaceholder(props: NodePlaceholderProps) {
  const { node, ports, reason, selected, remove, t, detail } = props
  const card = useRef<HTMLElement>(null)
  const [preview, setPreview] = useState<ResourceSize | null>(null)
  const size = { width: props.resourcePreviewWidth ?? RESOURCE_CARD_WIDTH,
    height: props.resourcePreviewHeight ?? RESOURCE_MIN_PREVIEW_HEIGHT }
  return <article ref={card} className={css.node}
    style={{ width: preview?.width ?? size.width, minHeight: preview?.height ?? size.height }}
    data-selected={selected || undefined} data-convax-placeholder={reason}>
    <CardToolbar nodeId={node.id} name={node.typeId} t={t}
      actions={[{ id: 'remove', label: t('files.reference'), onClick: remove }]} />
    <NodePorts nodeId={node.id} ports={ports} connectable={false} />
    <div className={css.nodeHeader}>
      <span className={css.nodeTitle}>{node.typeId}</span>
    </div>
    <p className={css.nodeStatus} role="status">{t(`node.${reason}`)}</p>
    {detail !== undefined && <p className={css.nodeStatus}>{detail}</p>}
    <div className={css.nodePath}>{t('node.version', { version: node.dataVersion })}</div>
    <CardResizeHandle container={card} content={card} size={size} collapsed={false} resize={resizeResource}
      preview={setPreview} commit={props.setResourcePreviewSize}
      label={t('files.preview.resize')} help={t('files.preview.resizeHelp')} />
  </article>
}

/** Effect-owned registry over the public keyed node Slot. */
export class ConvaxRenderer extends Service implements IConvaxRenderer {
  private readonly registrations = new Set<CanvasNodeTypeId>()

  /** @param ctx - Renderer context that owns the service. */
  constructor(ctx: Context) { super(ctx, 'convaxRenderer') }

  registerNodeRenderer(typeId: CanvasNodeTypeId, definition: CanvasNodeRendererDefinition): () => void {
    if (this.registrations.has(typeId)) throw new Error(`Convax node renderer already registered: ${typeId}`)
    const { dataVersion, component: Component } = definition
    const dispose = this.ctx.effect(() => {
      this.registrations.add(typeId)
      let remove: () => void
      try {
        remove = this.ctx.slots.inject('convax.node', () => this.ctx.slots.register({
          name: 'convax.node', key: typeId, locale: NS,
        }, (props: CanvasNodeRendererProps) => {
          if (props.node.dataVersion !== dataVersion) return <NodePlaceholder {...props} reason="rendererVersion" />
          return <Component {...props} />
        }))
      } catch (error) {
        this.registrations.delete(typeId)
        throw error
      }
      return () => { remove(); this.registrations.delete(typeId) }
    }, `convaxRenderer: ${typeId}`)
    return () => { void dispose() }
  }
}

/**
 * Present a validated file or folder reference through the canvas resource actions.
 * @param props - Compatible reference payload and revision-bound graph actions.
 * @returns The reference card and its named ports.
 */
export function ResourceNode(props: CanvasNodeRendererProps) {
  const { node, selected, remove, t, ports, busy } = props
  const card = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<ResourceSize | null>(null)
  const expanded = props.resourceExpanded
  const path = typeof node.data.path === 'string' ? node.data.path : ''
  const folder = node.typeId === 'convax.folder'
  const media = folder ? undefined : mediaKind(path)
  const video = media === 'video'
  const audio = media === 'audio'
  const minimumHeight = audio ? AUDIO_PREVIEW_HEIGHT : RESOURCE_MIN_PREVIEW_HEIGHT
  const width = props.resourcePreviewWidth ?? RESOURCE_CARD_WIDTH
  const dimensions: ResourceSize = {
    width,
    height: props.resourcePreviewHeight ?? (video ? width * 9 / 16 : audio ? AUDIO_PREVIEW_HEIGHT : RESOURCE_PREVIEW_HEIGHT),
  }
  const contentsId = useId()
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? node.typeId
  const resource = props.useResource<'convax-resource'>(resourceAddress('convax-resource', path))
  const extension = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : ''
  const type = folder ? t('files.type.folder') : extension || t('files.type.file')
  const size = resource.value?.kind === 'file' && resource.value.size !== null ? fileSizeText(resource.value.size) : null
  const metadata = size === null ? type : `${type} · ${size}`
  return <article ref={card} className={`${css.node} ${css.resourceNode}`}
    style={{ width: preview?.width ?? dimensions.width }}
    data-selected={selected || undefined} data-convax-resource={node.id}
    data-expanded={expanded || undefined} data-convax-file={!folder || undefined} data-convax-video={video || undefined}
    data-convax-audio={audio || undefined}>
    <CardToolbar nodeId={node.id} name={name} t={t} actions={[
      { id: 'zoom', label: t(folder ? 'node.focus' : 'files.preview.expand'),
        onClick: folder ? props.focusNode : () => { props.openResource({ path, name, kind: 'file', size: null }) } },
      { id: 'source', label: t('files.openSource'), onClick: () => { props.openSource(path) } },
      ...folder ? [{ id: 'chat' as const, label: t('chat.new'), disabled: busy, onClick: () => { props.createChat(path, node.id) } }] : [],
      { id: 'remove', label: t('files.reference'), disabled: busy, onClick: remove },
    ]} />
    <NodePorts nodeId={node.id} ports={ports} connectable={!busy} />
    <div className={css.resourceHeader} data-convax-resource-header="">
      <div className={css.resourceHeading}>
        <Tooltip label={t(expanded ? 'files.collapse' : 'files.expand', { name })} portal>
          <Button size="sm" className={`${css.resourceToggle} nodrag nopan`}
            aria-label={t(expanded ? 'files.collapse' : 'files.expand', { name })}
            aria-expanded={expanded} aria-controls={contentsId} onClick={() => { setPreview(null); props.setResourceExpanded(!expanded) }}>
            {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </Button>
        </Tooltip>
        {folder ? <FileIcon kind="folder" size={16} /> : <FileIcon path={path || name} size={16} />}
        <div className={css.resourceIdentity}>
          <Tooltip label={`${name} · ${metadata}`} portal><span className={css.nodeTitle}>{name}</span></Tooltip>
        </div>
        <div className={css.resourceMetadata}>
          {media === undefined ? <Tooltip label={metadata} portal><span className={css.resourceMeta}>{metadata}</span></Tooltip>
            : props.renderFactorySlot('convax.media.preview', {
              path, presentation: audio && !expanded ? 'compact' : 'metadata', metadataFallback: metadata,
            }, { fallback: <span className={css.resourceMeta}>{metadata}</span> })}
        </div>
      </div>
    </div>
    {folder && expanded && <div ref={body} id={contentsId} className={css.directoryPreview}
      style={{ height: preview?.height ?? dimensions.height }} data-convax-directory-preview="">
      <div className={`${css.treeViewport} nodrag nopan`} data-convax-directory-tree="">
        <ResourceDirectory path={path} name={name} useResource={props.useResource} openResource={props.openResource} t={t} />
      </div>
    </div>}
    {!folder && expanded && <div ref={body} id={contentsId} className={`${css.resourcePreview} nodrag nopan`}
      style={{ height: preview?.height ?? dimensions.height, minHeight: minimumHeight }} data-convax-file-preview="">
      <div className={css.resourcePreviewContents}>
        <ResourcePreview path={path} gestureMode="container" useResource={props.useResource}
          renderFactorySlot={props.renderFactorySlot} t={t} />
      </div>
    </div>}
    <CardResizeHandle container={card} content={body} size={dimensions} collapsed={!expanded}
      resize={(start, dx, dy, scale) => resizeResource(start, dx, dy, scale, minimumHeight)}
      preview={setPreview} commit={props.setResourcePreviewSize}
      label={t('files.preview.resize')} help={t('files.preview.resizeHelp')} />
  </article>
}

/**
 * Place the shared Chat Factory behind the same versioned registration as extension nodes.
 * @param props - Compatible Chat payload and its durable Session bindings.
 * @returns The Chat assembly or a placeholder while its binding projection is unavailable.
 */
export function ChatNode(props: CanvasNodeRendererProps) {
  return props.chat === undefined ? <NodePlaceholder {...props} reason="incompatible" /> : props.renderFactorySlot('convax.chat.content', {
    chat: props.chat, canvasRevision: props.canvasRevision, remove: props.remove, consumeFocus: props.consumeFocus,
    focusNode: props.focusNode,
    ...(props.focusSessionId === undefined ? {} : { focusSessionId: props.focusSessionId }),
  })
}
