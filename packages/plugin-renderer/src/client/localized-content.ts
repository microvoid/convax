/** Display system-owned names without translating literal user content. */
import type { CanvasDocument, CanvasTitleFormat } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './props.ts'

/**
 * Resolve a system naming recipe in the current render language.
 * @param canvas - Saved literal fallback and optional system naming recipe.
 * @param t - Current Convax translation seat.
 * @returns Localized default or copy name; unmarked saved titles remain literal.
 */
export function canvasDisplayTitle(canvas: Pick<CanvasDocument, 'title' | 'titleFormat'>, t: TranslateNS<'convax'>): string {
  const resolve = (format: CanvasTitleFormat): string => {
    switch (format.kind) {
      case 'default': return t('canvas.untitled')
      case 'literal': return format.value
      case 'copy': return t('canvas.copyName', { name: resolve(format.source) })
    }
  }
  return canvas.titleFormat === undefined ? canvas.title : resolve(canvas.titleFormat)
}
