/** Container-independent browser Factory backed by the window's browser instances. */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserViews, BrowserViewId, BrowserViewStates } from '../browser/BrowserViews.ts'
import type { BrowserStore } from '../browser/store.ts'
import type { BrowserTabState } from '../browser/BrowserPersistence.ts'
import { currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import { emptyBrowserFrame } from '../browser/BrowserFrame.ts'
import { BrowserChrome } from './BrowserChrome.tsx'
import css from './Browser.module.css'

/** Plain view commands and a renderer-bound snapshot source. */
export interface BrowserContentInjected {
  readonly hooks: { readonly browserViews: BrowserViews['states'] }
  readonly mountBrowser: (id: BrowserViewId, viewportId: string, initialUrl: string | undefined,
    initial: BrowserTabState | undefined) => () => void
  readonly loadUrl: BrowserViews['loadUrl']
  readonly restore: BrowserViews['restore']
  readonly goBack: BrowserViews['goBack']
  readonly goForward: BrowserViews['goForward']
  readonly reload: BrowserViews['reload']
  readonly setSandbox: BrowserViews['setSandbox']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** A browser page whose identity and lifetime are supplied by an independent owner. */
    'browser.content': {
      scope: 'root'
      props: { readonly browserId: BrowserViewId; readonly initialUrl?: string | undefined; readonly active?: boolean | undefined }
      locale: 'sidebarBrowser'
      store: BrowserStore
      inject: BrowserContentInjected
    }
  }
}

/**
 * Bind browser Factory commands.
 * @param views - Window-owned pages. @param actions - Checkpoint writer.
 * @returns narrow commands and observable state.
 */
export function browserContentInjected(views: BrowserViews, actions: BoundActions<BrowserStore>): BrowserContentInjected {
  views.rebind(actions)
  return {
    hooks: { browserViews: views.states },
    mountBrowser: (id, viewport, url, initial) => views.mount(id, viewport, url, initial, actions),
    loadUrl: (id, url) => { views.loadUrl(id, url) }, restore: (id) => { views.restore(id) },
    goBack: (id) => { views.goBack(id) }, goForward: (id) => { views.goForward(id) }, reload: (id) => { views.reload(id) },
    setSandbox: (id, enabled) => { views.setSandbox(id, enabled) },
  }
}

/** Independent browser Factory inputs with framework-bound store and hooks. */
export type BrowserContentProps = FactoryComponentPropsOf<'browser.content'>

/**
 * Keep browser DOM stable across visibility changes.
 * @param props - Independent view identity and bound state.
 * @returns shared browser chrome.
 */
export function BrowserContent(props: BrowserContentProps) {
  const { browserId, initialUrl, active = true, useBrowserViews, useStore, mountBrowser, t } = props
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = root.current
    if (element === null) return
    element.inert = !active
    const focused = element.ownerDocument.activeElement
    if (!active && focused instanceof HTMLElement && element.contains(focused)) focused.blur()
  }, [active])
  const snapshot = useBrowserViews((states: BrowserViewStates) => states[browserId])
  const saved = useStore(state => state.byTab[String(browserId) as TabId])
  const initial = useRef(saved)
  const initialAddress = useRef(initialUrl)
  const viewportId = useId()
  const [mounted, setMounted] = useState(false)
  const registered = snapshot !== undefined
  useLayoutEffect(() => {
    if (!registered) return
    const hide = mountBrowser(browserId, viewportId, initialAddress.current, initial.current)
    setMounted(true)
    return hide
  }, [registered, browserId, viewportId, mountBrowser])
  const state = snapshot ?? { frame: emptyBrowserFrame(), restoreTarget: currentBrowserTarget(initial.current),
    addressFailure: undefined, addressRevision: 0 }
  return <div ref={root} className={css.root} aria-hidden={!active || undefined} data-browser-view={browserId}>
    <BrowserChrome state={state} initialUrl={initialUrl} viewportId={viewportId} mounted={mounted} t={t}
      loadUrl={(url) => { props.loadUrl(browserId, url) }} restore={() => { props.restore(browserId) }}
      goBack={() => { props.goBack(browserId) }} goForward={() => { props.goForward(browserId) }}
      reload={() => { props.reload(browserId) }} setSandbox={(enabled) => { props.setSandbox(browserId, enabled) }} />
  </div>
}

/** Keep checkpoint writes available without visible browser content. @returns no visible UI. */
export function BrowserStateHost(): null { return null }
