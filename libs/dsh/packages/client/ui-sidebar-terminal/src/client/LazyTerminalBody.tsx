/** Load xterm only after a terminal body is mounted. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { TerminalSurfaceProps } from './face.ts'
import type { TerminalBodyProps } from './terminal.tsx'

const loadTerminal = () => import('./terminal.tsx')
const LoadedTerminalBody = lazy(async () => ({ default: (await loadTerminal()).TerminalBody }))

/**
 * Suspend while the package-local terminal chunk arrives.
 * @param props - Terminal body props supplied by the sidebar slot.
 * @returns the deferred terminal renderer.
 */
export function LazyTerminalBody(props: TerminalBodyProps): ReactNode {
  return <Suspense fallback={null}><LoadedTerminalBody {...props} /></Suspense>
}

const LoadedTerminalSurface = lazy(async () => ({ default: (await loadTerminal()).TerminalSurface }))

/** @param props - Container-independent terminal inputs. @returns The lazily loaded emulator. */
export function LazyTerminalSurface(props: TerminalSurfaceProps): ReactNode {
  return <Suspense fallback={null}><LoadedTerminalSurface {...props} /></Suspense>
}
