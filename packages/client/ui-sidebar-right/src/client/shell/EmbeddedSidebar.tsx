/** Native Session tools presented as a normal-flow workspace companion. */
import { useLayoutEffect, useRef, useState } from 'react'
import type { FactoryComponentPropsOf, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EmbeddedSidebarResizeHandle } from './EmbeddedSidebarResizeHandle.tsx'
import css from './SidebarRight.module.css'

/** Plain callbacks owned by the sidebar plugin's Session retention and host registry. */
export interface EmbeddedSidebarInjected {
  /** @returns Releases this committed workspace claim. */
  mount: () => () => void
  /** @param tabId - Initialized body. @param signal - Occurrence lifetime. @returns Releases the body's Session reference. */
  retainTab: (tabId: TabId, signal: AbortSignal) => () => void
}

/**
 * Place the same native tool assembly beside an embedding workspace's content.
 * @param props - Explicit normal/expanded widths, activity, shared store and Session callbacks.
 * @returns A normal-flow companion whose collapsed state occupies no width.
 */
export function EmbeddedSidebar({ sessionId, width, fullscreenWidth, active = true, resize, useStore, mount, retainTab, renderFactorySlot }:
FactoryComponentPropsOf<'sidebar.right.embedded'>) {
  const container = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<{ sessionId: SessionId; fullscreen: boolean; width: number } | null>(null)
  const layout = useStore(state => state.bySession[sessionId]?.layout)
  const expanded = active && layout?.expanded === true
  const fullscreen = layout?.mode === 'fullscreen'
  const resizing = expanded && resize !== undefined && preview?.sessionId === sessionId && preview.fullscreen === fullscreen
  const effectiveWidth = resizing ? preview.width : fullscreen ? fullscreenWidth : width
  useLayoutEffect(mount, [mount])
  return <div ref={container} className={css.embedded} hidden={!active}
    data-sidebar-right-embedded={sessionId} data-sidebar-right-expanded={expanded || undefined}
    data-sidebar-right-resizing={resizing || undefined}
    style={{ width: expanded ? effectiveWidth : 0 }}>
    {renderFactorySlot('sidebar.right.content', {
      width: effectiveWidth, viewportWidth: fullscreenWidth, canShow: true,
      active, retainTab, embedded: true,
    })}
    {expanded && resize !== undefined && <EmbeddedSidebarResizeHandle container={container} sessionId={sessionId}
      fullscreen={fullscreen} resize={resize} preview={(next) => {
        setPreview(next === null ? null : { sessionId, fullscreen, width: next })
      }} />}
  </div>
}

/**
 * Keep the native frame's Session entry on the same reusable tool assembly.
 * @param props - Frame geometry and retained view callbacks.
 * @returns The shared native Sidebar Factory.
 */
export function RightbarSession({ renderFactorySlot, width, viewportWidth, canShow, active, retainTab }:
  PropsRuntime<'rightbar.session'> & PropsRenderFactories) {
  return renderFactorySlot('sidebar.right.content', { width, viewportWidth, canShow, active, retainTab })
}
