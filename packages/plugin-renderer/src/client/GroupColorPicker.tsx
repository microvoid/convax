/** One portaled palette serves pointer previews, keyboard selection and touch sheets. */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check, X } from 'lucide-react'
import { Button, MenuSurface, isBehindModal, useAnchoredPosition, useDismissOnOutsidePointer, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasGroupColor } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { WorkspaceProps } from './props.ts'
import css from './GroupColorPicker.module.css'
import colors from './GroupColors.module.css'

const COLORS = [null, 'blue', 'green', 'yellow', 'orange', 'purple', 'pink'] as const
const SHEET_QUERY = '(max-width: 600px), (pointer: coarse)'
const HIDDEN: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Render a bounded, focus-managed palette without saving its transient preview. */
export function GroupColorPicker({ anchorRef, current, pending, preview, apply, close, t }: {
  readonly anchorRef: RefObject<HTMLElement | null>
  readonly current: CanvasGroupColor | null | 'mixed'
  readonly pending: boolean
  readonly preview: (color: CanvasGroupColor | null | undefined) => void
  readonly apply: (color: CanvasGroupColor | null) => void
  readonly close: () => void
  readonly t: WorkspaceProps['t']
}) {
  const panel = useRef<HTMLDivElement>(null)
  const focused = useRef(false)
  const [sheet, setSheet] = useState(() => typeof matchMedia === 'function' && matchMedia(SHEET_QUERY).matches)
  const position = useAnchoredPosition({ open: !sheet, anchorRef, panelRef: panel, gap: 6, margin: 12 })
  useDismissOnOutsidePointer(anchorRef, true, close, panel)
  useModalLayer(panel, true, close)
  useLayoutEffect(() => {
    if (focused.current || !sheet && position === null) return
    const element = panel.current
    if (element === null) return
    // A popover's first hidden layout cannot receive focus until its anchor has been measured.
    if (!element.contains(element.ownerDocument.activeElement)) {
      element.querySelector<HTMLElement>('[data-modal-autofocus]')?.focus({ preventScroll: true })
    }
    focused.current = true
  }, [position, sheet])
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia(SHEET_QUERY)
    const change = (): void => { setSheet(query.matches); preview(undefined) }
    query.addEventListener('change', change)
    return () => { query.removeEventListener('change', change) }
  }, [preview])
  useEffect(() => {
    const anchor = anchorRef.current
    const title = anchor?.closest<HTMLElement>('[data-convax-group-header]') ?? anchor
    const owner = anchor?.ownerDocument ?? document
    let outside: HTMLElement | null = null
    const rememberOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || panel.current?.contains(event.target) || anchor?.contains(event.target)) return
      outside = event.target.closest<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )
    }
    owner.addEventListener('pointerdown', rememberOutside, true)
    return () => {
      owner.removeEventListener('pointerdown', rememberOutside, true)
      const target = outside ?? title
      if (target?.isConnected && !isBehindModal(target)) target.focus({ preventScroll: true })
    }
  }, [anchorRef])
  const name = (color: CanvasGroupColor | null | 'mixed'): string => t(`group.color.${color ?? 'default'}`)
  return createPortal(<MenuSurface ref={panel} role="dialog" aria-modal="true" aria-label={t('group.color')}
    tabIndex={-1} data-convax-group-color-picker="" data-mode={sheet ? 'sheet' : 'popover'}
    className={css.panel} style={sheet ? undefined : position ?? HIDDEN}
    onPointerDown={(event) => { event.stopPropagation() }} onClick={(event) => { event.stopPropagation() }}>
    <header className={css.heading}>
      <span>{t('group.color')}</span>
      <Button size="sm" aria-label={t('group.color.close')} data-modal-autofocus onClick={close}><X size={16} aria-hidden /></Button>
    </header>
    <p className={css.current}>{t('group.color.current', { color: name(current) })}</p>
    <div className={css.palette} role="radiogroup" aria-label={t('group.color.presets')} aria-busy={pending}
      onPointerLeave={() => { preview(undefined) }} onKeyDown={(event) => {
        const offset = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 }[event.key]
        if (offset === undefined || event.altKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return
        const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = choices.findIndex(choice => choice === event.target)
        if (index < 0) return
        event.preventDefault()
        choices[(index + offset + choices.length) % choices.length]?.focus()
      }}>
      {COLORS.map(color => <button key={color ?? 'default'} type="button" role="radio" aria-label={name(color)}
        aria-checked={color === current} disabled={pending} className={`${css.swatch} ${colors.color}`}
        data-convax-group-color={color ?? 'default'} data-color={color ?? 'default'}
        onPointerEnter={(event) => { if (!sheet && event.pointerType !== 'touch') preview(color) }}
        onFocus={() => { if (!sheet) preview(color) }} onBlur={() => { preview(undefined) }} onClick={() => { apply(color) }}>
        <span className={css.circle} aria-hidden="true" />
        <span className={css.label}>{name(color)}{color === current && <Check size={12} aria-hidden />}</span>
      </button>)}
    </div>
    <p className={css.hint}>{t(sheet ? 'group.color.tap' : 'group.color.preview')}</p>
  </MenuSurface>, document.body)
}
