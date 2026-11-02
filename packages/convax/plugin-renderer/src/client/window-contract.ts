/** Window mirror presentation uses injected runtime callbacks and detached state. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasNodeId, CanvasWindowBindingId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasNodeOwner } from './props.ts'

/** Runtime-only capture status; native handles and MediaStreams never enter the graph. */
export interface WindowMirrorState {
  readonly nodeId: CanvasNodeId
  readonly name: string
  readonly status: 'live' | 'disconnected'
}

/** Framework-bound read-only mirror callbacks; mounted views do not own the capture. */
export interface WindowMirrorInjected {
  readonly mountWindow: (nodeId: CanvasNodeId, bindingId: CanvasWindowBindingId, viewportId: string) => () => void
  readonly validateWindow: (nodeId: CanvasNodeId, bindingId: CanvasWindowBindingId) => Promise<void>
  readonly hooks: { readonly windowMirrors: ObservableSnapshot<Readonly<Record<string, WindowMirrorState>>> }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** A capture-retained window mirror under one graph node occurrence. */
    'convax.window.content': {
      scope: 'root'
      props: CanvasNodeOwner
      locale: 'convax'
      inject: WindowMirrorInjected
    }
  }
}

/** Window node inputs composed by the existing renderer Factory. */
export type WindowMirrorProps = FactoryComponentPropsOf<'convax.window.content'>
