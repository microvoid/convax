/** Icon creation actions retain their contributing feature's labels and callbacks. */
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasCreationDefinition } from './contributions.ts'
import type { WorkspaceProps } from './props.ts'
import css from './CanvasToolbar.module.css'

function ResourceAddButton({ entries, busy, create, label }: {
  readonly entries: readonly CanvasCreationDefinition[]
  readonly busy: boolean
  readonly create: (entry: CanvasCreationDefinition) => void
  readonly label: string
}) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal side="top" autoFocus onClose={() => { setOpen(false) }}
    anchor={<Tooltip label={label} disabled={open} side="top" portal>
      <Button className={css.button} disabled={busy} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}><Plus size={16} aria-hidden /></Button>
    </Tooltip>}
    items={entries.map((entry) => {
      const Icon = entry.icon
      return { id: entry.id, label: typeof entry.label === 'string' ? entry.label : entry.label(), disabled: busy,
        ...Icon === undefined ? {} : { icon: <Icon size={16} aria-hidden /> } }
    })}
    onSelect={(id) => {
      setOpen(false)
      const entry = entries.find(value => value.id === id)
      if (entry !== undefined) create(entry)
    }} />
}

/**
 * Group resource intake behind one add button and expose other creations as labeled icons.
 * @param props - Current contributions, mutation availability, translated copy, and the graph's creation action.
 * @returns Controls without viewport positioning or business workflow ownership.
 */
export function CanvasAddToolbar({ creations, busy, create, t }: {
  readonly creations: readonly CanvasCreationDefinition[]
  readonly busy: boolean
  readonly create: (entry: CanvasCreationDefinition) => void
  readonly t: WorkspaceProps['t']
}) {
  const resources = creations.filter(entry => entry.dockGroup === 'resources')
  return <div className={css.items}>
    {resources.length > 0 && <ResourceAddButton entries={resources} busy={busy} create={create} label={t('workspace.addResources')} />}
    {creations.filter(entry => entry.dockGroup !== 'resources').map((entry) => {
      const Icon = entry.icon ?? Plus
      const label = typeof entry.label === 'string' ? entry.label : entry.label()
      return <Tooltip key={entry.id} label={label} side="top" portal>
        <Button className={css.button} disabled={busy} aria-label={label} onClick={() => { create(entry) }}>
          <Icon size={16} aria-hidden />
        </Button>
      </Tooltip>
    })}
  </div>
}
