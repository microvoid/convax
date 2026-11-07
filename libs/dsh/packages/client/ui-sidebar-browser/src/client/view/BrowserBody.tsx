/** Sidebar tab adapter for the shared browser chrome and retained page. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import type { BrowserStore } from '../browser/store.ts'
import { currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import { emptyBrowserFrame } from '../browser/BrowserFrame.ts'
import { BrowserChrome } from './BrowserChrome.tsx'

/** Browser body props assembled by the tab seat. */
export type BrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<BrowserStore> & PropsLocale<'sidebarBrowser'> & InjectFace<BrowserInjected>

/** Render a native Sidebar page. @param props - Bound tab state and actions. @returns browser chrome. */
export function BrowserBody(props: BrowserBodyProps) {
  const { mount, loadUrl, restore, goBack, goForward, reload, setSandbox, useBrowserState, useStore, useTabInfo, t } = props
  const { tab } = useTabInfo()
  useEffect(() => tab.actions.bindCommands({ refresh: () => { reload(tab.id) } }), [tab.actions, tab.id, reload])
  const saved = useStore(state => state.byTab[tab.id])
  const initial = useRef(saved)
  const initialUrl = useRef(tab.navigation.params?.url)
  const viewportId = useId()
  const [mounted, setMounted] = useState(false)
  const current = useBrowserState(tab.id)
  const state = current ?? { frame: emptyBrowserFrame(), restoreTarget: currentBrowserTarget(initial.current),
    addressFailure: undefined, addressRevision: 0 }
  useLayoutEffect(() => {
    const hide = mount({ tabId: tab.id, signal: tab.signal, viewportId, applicationOrigin: window.location.origin,
      initial: initial.current, initialUrl: initialUrl.current,
      openTab: (url) => { tab.actions.openTab('browser', { params: { url }, revealIfOpened: false }) } })
    setMounted(true)
    return hide
  }, [mount, tab.id, tab.signal, tab.actions, viewportId, props.actions])
  return <BrowserChrome state={state} initialUrl={initialUrl.current} viewportId={viewportId} mounted={mounted}
    refreshShortcut={tab.refreshShortcut} t={t} loadUrl={(url) => { loadUrl(tab.id, url) }}
    restore={() => { restore(tab.id) }} goBack={() => { goBack(tab.id) }} goForward={() => { goForward(tab.id) }}
    reload={() => { reload(tab.id) }} setSandbox={(enabled) => { setSandbox(tab.id, enabled) }} />
}
