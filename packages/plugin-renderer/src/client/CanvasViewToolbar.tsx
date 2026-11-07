/** Icon-only viewport controls delegate navigation and saved preferences to the graph. */
import { useState } from 'react'
import { Mouse, Redo2, RotateCcw, Scan, Touchpad, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import { Button, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasInputMode } from './input-mode.ts'
import type { WorkspaceProps } from './props.ts'
import css from './CanvasToolbar.module.css'

/**
 * Expose input mode, viewport navigation and history through the shared canvas bar.
 * @param props - Current presentation, translated labels and owner-provided actions and availability.
 * @returns Icon controls with a portaled input-mode menu and accessible current zoom.
 */
export function CanvasViewToolbar({
  inputMode, setInputMode, zoom, locale, zoomOut, resetZoom, zoomIn, fit, undo, redo, undoDisabled, redoDisabled, className, t,
}: {
  readonly inputMode: CanvasInputMode
  readonly setInputMode: (mode: CanvasInputMode) => void
  readonly zoom: number
  readonly locale: string
  readonly zoomOut: () => void
  readonly resetZoom: () => void
  readonly zoomIn: () => void
  readonly fit: () => void
  readonly undo: () => void
  readonly redo: () => void
  readonly undoDisabled: boolean
  readonly redoDisabled: boolean
  readonly className?: string | undefined
  readonly t: WorkspaceProps['t']
}) {
  const [modeOpen, setModeOpen] = useState(false)
  const ModeIcon = inputMode === 'touchpad' ? Touchpad : Mouse
  const modeLabel = t(inputMode === 'touchpad' ? 'canvas.input.touchpad' : 'canvas.input.mouse')
  const zoomLabel = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(zoom)
  return <div className={`${css.bar} ${className ?? ''}`} data-convax-view-toolbar="">
    <Menu open={modeOpen} portal side="top" autoFocus selectedId={inputMode} onClose={() => { setModeOpen(false) }}
      anchor={<Tooltip label={modeLabel} disabled={modeOpen} side="top" portal>
        <Button className={css.button} aria-label={t('canvas.inputMode')} aria-description={modeLabel}
          aria-haspopup="menu" aria-expanded={modeOpen} onClick={() => { setModeOpen(current => !current) }}>
          <ModeIcon size={16} aria-hidden />
        </Button>
      </Tooltip>}
      items={[
        { id: 'touchpad', label: t('canvas.input.touchpad'), icon: <Touchpad size={16} aria-hidden /> },
        { id: 'mouse', label: t('canvas.input.mouse'), icon: <Mouse size={16} aria-hidden /> },
      ]} onSelect={(id) => {
        setModeOpen(false)
        if (id === 'touchpad' || id === 'mouse') setInputMode(id)
      }} />
    <Tooltip label={t('canvas.zoom.out')} side="top" portal>
      <Button className={css.button} aria-label={t('canvas.zoom.out')} onClick={zoomOut}><ZoomOut size={16} aria-hidden /></Button>
    </Tooltip>
    <Tooltip label={`${zoomLabel} · ${t('canvas.zoom.reset')}`} side="top" portal>
      <Button className={css.button} aria-label={t('canvas.zoom.reset')} aria-description={zoomLabel} onClick={resetZoom}><RotateCcw size={16} aria-hidden /></Button>
    </Tooltip>
    <Tooltip label={t('canvas.zoom.in')} side="top" portal>
      <Button className={css.button} aria-label={t('canvas.zoom.in')} onClick={zoomIn}><ZoomIn size={16} aria-hidden /></Button>
    </Tooltip>
    <Tooltip label={t('canvas.zoom.fit')} side="top" portal>
      <Button className={css.button} aria-label={t('canvas.zoom.fit')} onClick={fit}><Scan size={16} aria-hidden /></Button>
    </Tooltip>
    <Tooltip label={t('history.undo')} side="top" portal>
      <Button className={css.button} aria-label={t('history.undo')} disabled={undoDisabled} onClick={undo}><Undo2 size={16} aria-hidden /></Button>
    </Tooltip>
    <Tooltip label={t('history.redo')} side="top" portal>
      <Button className={css.button} aria-label={t('history.redo')} disabled={redoDisabled} onClick={redo}><Redo2 size={16} aria-hidden /></Button>
    </Tooltip>
  </div>
}
