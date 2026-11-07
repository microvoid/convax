/** Injected terminal commands and keyed observable state. */
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { TerminalView, TerminalViewState, TerminalControls } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { HostObservable, FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** The terminal's React-free model is resolved by sidebar occurrence. */
export interface TerminalInjected {
  /** @param key - sidebar occurrence key. @returns its terminal commands. */
  readonly view: (key: string) => TerminalView
  readonly keyedHooks: { readonly terminal: (key: string) => HostObservable<TerminalViewState> }
}


/** The terminal screen follows the resolved application theme through a framework hook. */
export interface TerminalBodyInjected extends TerminalInjected {
  readonly hooks: { readonly theme: HostObservable<ThemeSnapshot> }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** An existing Host terminal selected from the Session terminal list. */
    terminal: { terminalId: WebTerminalId } | { shellPath: string }
  }
}

/** Container-independent inputs for the shared terminal content. */
export interface TerminalSurfaceOwner {
  readonly model: TerminalControls
  readonly state: TerminalViewState
  readonly visible: boolean
  readonly autoFocus?: boolean
  readonly onNewTerminal: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Interactive terminal content shared by the sidebar and other containers. */
    'terminal.content': {
      scope: 'root'
      locale: 'sidebarTerminal'
      props: TerminalSurfaceOwner
      inject: Pick<TerminalBodyInjected, 'hooks'>
    }
  }
}

/** Framework-composed shared terminal renderer inputs. */
export type TerminalSurfaceProps = Pick<FactoryComponentPropsOf<'terminal.content'>, keyof TerminalSurfaceOwner | 'useTheme' | 't'>
