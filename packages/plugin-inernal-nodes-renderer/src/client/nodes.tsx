/** Default reference and conversation cards use the public node registration API. */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Button, fileSizeText, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { NodePorts, NodePlaceholder, CardToolbar, CardResizeHandle, resourceAddress, RESOURCE_CARD_WIDTH,
  AUDIO_PREVIEW_HEIGHT, resizeResource, RESOURCE_MIN_PREVIEW_HEIGHT, RESOURCE_PREVIEW_HEIGHT } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type { CanvasNodeRendererProps, ResourceSize } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { FileIcon } from './FileIcon.tsx'
import { ResourceDirectory } from './ResourceDirectory.tsx'
import { ResourcePreview } from './ResourcePreview.tsx'
import { mediaKind } from './media-kind.ts'
import css from './NodeCard.module.css'

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
