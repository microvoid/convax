/** Raw provider diagnostics stay separate from localized user guidance. */
import type { WorkspaceProps } from './props.ts'

/**
 * Retain technical error text in an explicitly disclosed detail region.
 * @param props - Original diagnostic and current translation seat.
 * @returns Collapsed technical details whose label follows the UI language.
 */
export function DiagnosticDetails({ diagnostic, t }: { diagnostic: string; t: WorkspaceProps['t'] }) {
  return <details data-convax-diagnostic><summary>{t('diagnostic.details')}</summary>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{diagnostic}</pre>
  </details>
}
