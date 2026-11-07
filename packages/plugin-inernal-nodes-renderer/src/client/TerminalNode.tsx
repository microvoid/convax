/** Canvas terminal card around the shared DSH terminal content. */
import { useRef, useState } from 'react'
import { TerminalSquare } from 'lucide-react'
import { CardResizeHandle, CardToolbar, NodePorts, resizeResource } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type { CanvasNodeOwner, CanvasNodeRendererProps, ResourceSize } from '@deepseek-ai/dsh-convax-plugin-renderer/client'
import type { TerminalControls, TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-terminal/client'
import type { FactoryComponentPropsOf, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import css from './NodeCard.module.css'
import terminalCss from './TerminalNode.module.css'

/** Commands and subscriptions provided by the canvas-owned terminal coordinator. */
export interface TerminalCardInjected {
  readonly terminalModel: (id: string) => TerminalControls | undefined
  readonly restartTerminal: (id: string) => Promise<void>
  readonly keyedHooks: { readonly canvasTerminal: (id: string) => HostObservable<TerminalViewState> | undefined }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Graph card bound to one canvas-owned terminal. */
    'convax.terminal.content': { scope: 'root'; locale: 'convax'; props: CanvasNodeOwner; inject: TerminalCardInjected }
  }
}

/** @param props - Graph node and card presentation. @returns Its injected terminal card. */
export function TerminalNode(props: CanvasNodeRendererProps) {
  return props.renderFactorySlot('convax.terminal.content', {
    active: props.active, node: props.node, canvasId: props.canvasId, canvasRevision: props.canvasRevision,
    definition: props.definition, ports: props.ports, selected: props.selected, busy: props.busy, chat: props.chat,
    remove: props.remove, command: props.command, openResource: props.openResource, openSource: props.openSource,
    createChat: props.createChat, chooseWindow: props.chooseWindow, focusSessionId: props.focusSessionId,
    consumeFocus: props.consumeFocus, inputs: props.inputs, focusNode: props.focusNode,
    resourceExpanded: props.resourceExpanded, setResourceExpanded: props.setResourceExpanded,
    setResourcePreviewSize: props.setResourcePreviewSize,
    ...(props.resourcePreviewHeight === undefined ? {} : { resourcePreviewHeight: props.resourcePreviewHeight }),
    ...(props.resourcePreviewWidth === undefined ? {} : { resourcePreviewWidth: props.resourcePreviewWidth }),
  })
}

/** @param props - Terminal state, shared content and card actions. @returns The interactive terminal card. */
export function TerminalCard(props: FactoryComponentPropsOf<'convax.terminal.content'>) {
  const { node, t, ports, busy } = props
  const state = props.useCanvasTerminal(node.id)
  const model = props.terminalModel(node.id)
  const card = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<ResourceSize | null>(null)
  const size = { width: props.resourcePreviewWidth ?? 640, height: props.resourcePreviewHeight ?? 360 }
  const name = typeof node.data.title === 'string' ? node.data.title : t('terminal.title')
  return <article ref={card} className={`${css.node} ${css.resourceNode} ${terminalCss.node}`}
    style={{ width: preview?.width ?? size.width }} data-selected={props.selected || undefined}
    data-convax-terminal={node.id}>
    <CardToolbar nodeId={node.id} name={name} t={t} actions={[
      { id: 'zoom', label: t('node.focus'), onClick: props.focusNode },
      { id: 'remove', label: t('files.reference'), disabled: busy, onClick: props.remove },
    ]} />
    <NodePorts nodeId={node.id} ports={ports} connectable={!busy} />
    <header className={`${css.resourceHeader} ${terminalCss.header}`} data-convax-tool-drag="">
      <TerminalSquare size={16} aria-hidden /><span className={css.nodeTitle}>{name}</span>
      {state?.info?.cwd !== undefined && <span className={terminalCss.path} title={state.info.cwd}>{state.info.cwd}</span>}
    </header>
    <div ref={body} className={`${terminalCss.body} nodrag nopan nowheel`} style={{ height: preview?.height ?? size.height }}
      data-gesture-surface="content" data-canvas-native-shortcuts="" data-convax-input-owner="">
      {model !== undefined && state !== undefined && props.renderFactorySlot('terminal.content', {
        model, state, visible: props.active, onNewTerminal: () => { void props.restartTerminal(node.id) },
      })}
    </div>
    {props.active && <CardResizeHandle container={card} content={body} size={size} collapsed={false} resize={resizeResource}
      preview={setPreview} commit={props.setResourcePreviewSize}
      label={t('files.preview.resize')} help={t('files.preview.resizeHelp')} />}
  </article>
}
