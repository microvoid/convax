/** File resources feed the shared document Factory without creating Sessions or Sidebar tabs. */
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNodeRendererProps } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { resourceAddress } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import { mediaKind } from './media-kind.ts'
import type {} from './media-contract.ts'
import css from './ResourcePreview.module.css'

type ResourcePreviewProps = Pick<CanvasNodeRendererProps, 'useResource' | 'renderFactorySlot' | 't'> & {
  path: string
  gestureMode?: 'container'
}

/**
 * Keep loading, retry and missing-provider feedback inside the resource's preview area.
 * @param props - Source path, framework resource and Factory seats, and localized copy.
 * @returns Shared document content or a local preview status.
 */
export function ResourcePreview(props: ResourcePreviewProps) {
  return mediaKind(props.path) !== undefined
    ? props.renderFactorySlot('convax.media.preview', { path: props.path }, {
      fallback: <div className={css.status} role="status">{props.t('files.preview.providerUnavailable')}</div>,
    })
    : <DocumentResource {...props} />
}

function DocumentResource({ path, gestureMode, useResource, renderFactorySlot, t }: ResourcePreviewProps) {
  const [attempt, setAttempt] = useState(0)
  const document = useResource<'convax-document'>(`${resourceAddress('convax-document', path)}?attempt=${attempt}`)
  const failed = document.status === 'failed' || document.status === 'none'
  const code = document.failure?.code
  const message = code === 'canvas-resource/too-large' ? 'files.preview.tooLarge'
    : code === 'canvas-resource/source-changed' ? 'files.preview.sourceChanged'
      : code === 'document-render/failed' ? 'files.preview.officeUnavailable' : 'files.preview.failed'
  return <div className={css.preview} data-convax-document-preview="">
    {document.status === 'loading' && document.value === undefined && <div className={css.status}
      role="status" aria-label={t('files.loading', { name: path.split(/[\\/]/).at(-1) ?? path })}>
      <span className={css.spinner} aria-hidden="true" />
    </div>}
    {failed && <div className={document.value === undefined ? css.status : css.notice} role="alert">
      <span>{t(message)}</span>
      <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('workspace.retry')}</Button>
    </div>}
    {document.value !== undefined && renderFactorySlot('document.preview', {
      source: document.value, imageInset: 'none', ...(gestureMode === undefined ? {} : { gestureMode }),
    }, {
      fallback: <div className={css.status} role="status">{t('files.preview.providerUnavailable')}</div>,
    })}
  </div>
}
