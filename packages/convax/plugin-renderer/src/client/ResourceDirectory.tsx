/** Lazy directory disclosures backed by the existing live resource provider. */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { FileIcon } from './FileIcon.tsx'
import { useId, useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasResource } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasNodeRendererProps } from './props.ts'
import { resourceAddress } from './resources.ts'
import css from './NodeCard.module.css'

type DirectoryProps = Pick<CanvasNodeRendererProps, 'useResource' | 'openResource' | 't'> & {
  path: string
  name: string
}

function DirectoryEntry({ entry, ...props }: Omit<DirectoryProps, 'path' | 'name'> & { entry: CanvasResource }) {
  const [expanded, setExpanded] = useState(false)
  const contentsId = useId()
  const folder = entry.kind === 'folder'
  const label = folder ? props.t(expanded ? 'files.collapse' : 'files.expand', { name: entry.name }) : entry.name
  return <li className={css.treeItem}>
    <Tooltip label={entry.name} portal>
      <button type="button" className={css.treeRow} disabled={entry.kind === 'other'}
        aria-label={label} aria-expanded={folder ? expanded : undefined}
        aria-controls={folder ? contentsId : undefined}
        onClick={() => { if (folder) setExpanded(value => !value); else props.openResource(entry) }}>
        <span className={css.treeChevron} aria-hidden="true">
          {folder && (expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />)}
        </span>
        {folder ? <FileIcon kind="folder" size={16} /> : <FileIcon path={entry.path} size={16} />}
        <span className={css.treeName}>{entry.name}</span>
      </button>
    </Tooltip>
    {folder && expanded && <div id={contentsId}>
      <ResourceDirectory {...props} path={entry.path} name={entry.name} />
    </div>}
  </li>
}

/**
 * Read one expanded directory; collapsing its parent releases the resource occurrence.
 * @param props - Provider path, display name, framework resource hook, and existing preview action.
 * @returns A nested directory list with local loading, empty, and retry states.
 */
export function ResourceDirectory({ path, name, useResource, openResource, t }: DirectoryProps) {
  const [attempt, setAttempt] = useState(0)
  const resource = useResource<'convax-directory'>(`${resourceAddress('convax-directory', path)}?attempt=${attempt}`)
  return <ul className={css.treeLevel} aria-label={t('files.contents', { name })}>
    {resource.status === 'loading' && resource.value === undefined && <li className={css.treeState}
      role="status" aria-label={t('files.loading', { name })}><span className={css.treeSpinner} aria-hidden="true" /></li>}
    {(resource.status === 'failed' || resource.status === 'none') && <li className={css.treeState} role="alert">
      <span>{t('files.loadFailed', { name })}</span>
      <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('workspace.retry')}</Button>
    </li>}
    {resource.value?.entries.length === 0 && <li className={css.treeState} role="status">{t('files.empty')}</li>}
    {resource.value?.entries.map(entry => <DirectoryEntry key={entry.path} entry={entry}
      useResource={useResource} openResource={openResource} t={t} />)}
  </ul>
}
