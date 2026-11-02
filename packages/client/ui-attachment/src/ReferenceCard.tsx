/** Draft reference presentation sharing the pending-file card's layout and removal affordance. */
import {
  FileTypeIcon, IconCloseFillRegular, IconNewChatOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './FileCard.module.css'

/** One reference card's display text and glyph, independent of its source plugin. */
export interface ReferenceCardProps {
  readonly name: string
  readonly text: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly label: string
  readonly removeLabel: string
  readonly disabled: boolean
  readonly onRemove: () => void
}

/**
 * Render an unsent reference without file bytes or upload progress.
 * @param props - Display text, localized labels, and the draft removal action.
 * @returns A reference card with the same dimensions as a pending file.
 */
export function ReferenceCard({ name, text, appearance, label, removeLabel, disabled, onRemove }: ReferenceCardProps) {
  return (
    <div className={css.card} title={text}>
      <span className={css.icon} aria-hidden>
        {appearance === 'session'
          ? <IconNewChatOutlineRegular size={28} />
          : appearance === 'folder' ? <FileTypeIcon kind="folder" /> : <FileTypeIcon path={name} />}
      </span>
      <span className={css.body} aria-label={label}>
        <span className={css.name}>{name}</span>
        <span className={css.meta}>{text}</span>
      </span>
      <button type="button" className={css.remove} aria-label={removeLabel} disabled={disabled} onClick={onRemove}>
        <IconCloseFillRegular size={12} />
      </button>
    </div>
  )
}
