/** Main-panel and drawer carriers for the shared native plugin manager. */
import { Button, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createNavigationStore } from './navigation-store.ts'
import css from './PluginManagerSurface.module.css'

/**
 * Render native plugin management in its original main-panel position.
 * @param props - Main-panel seats and reusable Factory rendering.
 * @returns The native management content.
 */
export function PluginManagerMain(props: PropsRuntime<'main'> & PropsRenderFactories
  & PropsStore<ReturnType<typeof createNavigationStore>>) {
  const drawer = props.useStore(state => state.drawerOpen)
  if (drawer) return null
  return props.renderFactorySlot('plugins.manager.content', { presentation: 'page' })
}

/**
 * Keep the current workspace visible behind a right-side management drawer.
 * @param props - Overlay seats, localized chrome and the shared navigation owner.
 * @returns The native management content inside an accessible modal drawer.
 */
export function PluginManagerDrawer(props: PropsRuntime<'shell.overlay'> & PropsRenderFactories
  & PropsLocale<'pluginManager'> & PropsStore<ReturnType<typeof createNavigationStore>>) {
  const open = props.useStore(state => state.drawerOpen)
  return <Modal open={open} onClose={() => { props.actions.setDrawerOpen(false) }}
    title={props.t('title')} headless placement="right" backdropBlur={false} className={css.drawer as string}>
    <div className={css.chrome}>
      <Button size="sm" aria-label={props.t('close')} onClick={() => { props.actions.setDrawerOpen(false) }}>
        <IconCloseOutlineRegular size={16} />
      </Button>
    </div>
    <div className={css.content}>{props.renderFactorySlot('plugins.manager.content', { presentation: 'drawer' })}</div>
  </Modal>
}
