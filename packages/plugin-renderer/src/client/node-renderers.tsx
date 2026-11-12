/** Versioned node displays and reversible public canvas contributions. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { useLayoutEffect, useRef, useState } from 'react'
import { CanvasHandle, CanvasHandlePosition as Position, useCanvasNodeLayout } from './canvas-render-primitives.tsx'
import type { SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasData, CanvasNode, CanvasNodeId, CanvasNodeTypeId, CanvasPort, CanvasWorkspace } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasNodeOwner, CanvasNodeRendererProps, WorkspaceProps } from './props.ts'
import type { CanvasCreationDefinition, CanvasRendererSnapshot, CanvasWorkspaceActions, CanvasWorkspaceSnapshot } from './contributions.ts'
import { NS } from './locales.ts'
import { createChatViewStore } from './store.ts'
import { RESOURCE_CARD_WIDTH } from './placement.ts'
import { CardToolbar } from './CardToolbar.tsx'
import { DiagnosticDetails } from './DiagnosticDetails.tsx'
import { CardResizeHandle } from './CardResizeHandle.tsx'
import { resizeResource, RESOURCE_MIN_PREVIEW_HEIGHT, type ResourceSize } from './resource-size.ts'
import css from './NodeCard.module.css'

/** Supported payload version and its framework-composed display. */
export interface CanvasNodeRendererDefinition {
  /** Exact payload version this display understands. */
  dataVersion: number
  /** Use a registered Factory for additional stores, localization or child slots. */
  component: SlotComponent<CanvasNodeRendererProps>
  /** Initial geometry before the card has been measured. */
  defaultSize?: { readonly width: number; readonly height: number }
  /** Optional header selector that owns card movement. */
  dragHandle?: string
  /** Reuse compatible retained panel or preview preferences without a type-id branch. */
  presentation?: 'chat' | 'resource' | 'default'
  /** Initial inline content visibility before a saved preference exists. */
  defaultExpanded?: boolean
  /** Limit copied feature payloads while retaining ordinary provider data by default. */
  clipboardData?: (node: CanvasNode) => CanvasData
}

/** Client-only registration independent of the node's Host capabilities. */
export interface IConvaxRenderer {
  /**
   * Register one node display for the contributing plugin's lifetime.
   * @param typeId - Stable provider-qualified Host node type identity.
   * @param definition - Exact data version and display component.
   * @returns Idempotent disposer; removing a display preserves saved node data and Host behavior.
   * @throws When another active display owns this identity.
   */
  registerNodeRenderer(typeId: CanvasNodeTypeId, definition: CanvasNodeRendererDefinition): () => void
  /** Register a creation entry for the caller's plugin lifetime. */
  registerCreation(definition: CanvasCreationDefinition): () => void
  /** Install optional node actions without replacing the canvas workspace. */
  registerWorkspaceActions(actions: CanvasWorkspaceActions): () => void
  /** Read one stable definition and creation snapshot. */
  getSnapshot: () => CanvasRendererSnapshot
  /** Observe display and creation contributions. */
  subscribe: (listener: () => void) => () => void
  /** Observe committed workspace data without claiming ownership. */
  presentationStore: ReturnType<typeof createChatViewStore>
  workspace: CanvasWorkspaceSnapshot
  /** Publish a committed Remote result, preserving the same watch feed for all plugins. */
  acceptWorkspace(workspace: CanvasWorkspace): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Versioned Convax node display registrations. */
    convaxRenderer: IConvaxRenderer
  }
}

/** Why the saved node cannot currently show its business UI. */
export type NodePlaceholderReason = 'provider' | 'renderer' | 'rendererVersion' | 'migrating' | 'incompatible'

/** Presentation-only state of a retained node. */
export interface NodePlaceholderProps extends Pick<CanvasNodeOwner, 'resourcePreviewWidth' | 'resourcePreviewHeight' | 'setResourcePreviewSize'> {
  node: CanvasNode
  ports: readonly CanvasPort[]
  reason: NodePlaceholderReason
  selected: boolean
  remove: () => void
  t: WorkspaceProps['t']
  detail?: string | undefined
}

/**
 * Render stable named endpoints, including those retained from an unavailable provider.
 * @param props - Declared or retained ports and whether new connections are allowed.
 * @returns Handles at evenly spaced positions on each side.
 */
export function NodePorts({ nodeId, ports, connectable }: { nodeId: CanvasNodeId; ports: readonly CanvasPort[]; connectable: boolean }) {
  const updateNodeLayout = useCanvasNodeLayout()
  const endpoints = JSON.stringify(ports.map(port => [port.direction, port.id]))
  useLayoutEffect(() => { updateNodeLayout(nodeId) }, [nodeId, endpoints, updateNodeLayout])
  return <>{(['input', 'output'] as const).flatMap((direction) => {
    const group = ports.filter(port => port.direction === direction)
    return group.map((port, index) => <CanvasHandle key={`${direction}:${port.id}`}
      id={port.id} type={direction === 'input' ? 'target' : 'source'}
      position={direction === 'input' ? Position.Left : Position.Right}
      isConnectable={connectable} className={css.handle}
      style={{ top: `${(index + 1) * 100 / (group.length + 1)}%` }} />)
  })}</>
}

/**
 * Keep movement, deletion and existing relationships available without reading provider payloads.
 * @param props - Saved node identity and the reason its business display is unavailable.
 * @returns A localized placeholder with the node's original connection endpoints.
 */
export function NodePlaceholder(props: NodePlaceholderProps) {
  const { node, ports, reason, selected, remove, t, detail } = props
  const card = useRef<HTMLElement>(null)
  const [preview, setPreview] = useState<ResourceSize | null>(null)
  const size = { width: props.resourcePreviewWidth ?? RESOURCE_CARD_WIDTH,
    height: props.resourcePreviewHeight ?? RESOURCE_MIN_PREVIEW_HEIGHT }
  return <article ref={card} className={css.node}
    style={{ width: preview?.width ?? size.width, minHeight: preview?.height ?? size.height }}
    data-selected={selected || undefined} data-convax-placeholder={reason}>
    <CardToolbar nodeId={node.id} name={node.typeId} t={t}
      actions={[{ id: 'remove', label: t('files.reference'), onClick: remove }]} />
    <NodePorts nodeId={node.id} ports={ports} connectable={false} />
    <div className={css.nodeHeader}>
      <span className={css.nodeTitle}>{node.typeId}</span>
    </div>
    <p className={css.nodeStatus} role="status">{t(`node.${reason}`)}</p>
    {detail !== undefined && <DiagnosticDetails diagnostic={detail} t={t} />}
    <div className={css.nodePath}>{t('node.version', { version: node.dataVersion })}</div>
    <CardResizeHandle container={card} content={card} size={size} collapsed={false} resize={resizeResource}
      preview={setPreview} commit={props.setResourcePreviewSize}
      label={t('files.preview.resize')} help={t('files.preview.resizeHelp')} />
  </article>
}

/** Effect-owned registry over the public keyed node Slot. */
export class ConvaxRenderer extends Service implements IConvaxRenderer {
  private readonly slots: Context['slots']
  private readonly registrations = new Set<CanvasNodeTypeId>()
  private readonly definitions = new Map<CanvasNodeTypeId, CanvasNodeRendererDefinition>()
  private readonly creations = new Map<string, CanvasCreationDefinition>()
  private readonly listeners = new Set<() => void>()
  private readonly workspaceListeners = new Set<() => void>()
  private workspaceValue: CanvasWorkspace | undefined
  private actions: CanvasWorkspaceActions = {}
  private readonly actionOwners = new Set<CanvasWorkspaceActions>()
  private snapshot: CanvasRendererSnapshot = { definitions: {}, creations: [], actions: {} }
  readonly presentationStore = createChatViewStore()
  readonly workspace: CanvasWorkspaceSnapshot = {
    getSnapshot: () => this.workspaceValue,
    subscribe: (listener) => { this.workspaceListeners.add(listener); return () => { this.workspaceListeners.delete(listener) } },
  }
  readonly getSnapshot = (): CanvasRendererSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    this.snapshot = { definitions: Object.fromEntries(this.definitions), creations: [...this.creations.values()], actions: this.actions }
    for (const listener of this.listeners) listener()
  }

  acceptWorkspace(workspace: CanvasWorkspace): void {
    this.workspaceValue = workspace
    for (const listener of this.workspaceListeners) listener()
  }

  registerCreation(definition: CanvasCreationDefinition): () => void {
    if (this.creations.has(definition.id)) throw new Error(`Convax creation entry already registered: ${definition.id}`)
    const remove = this.ctx.effect(() => {
      this.creations.set(definition.id, definition)
      this.notify()
      return () => {
        if (this.creations.get(definition.id) !== definition) return
        this.creations.delete(definition.id)
        this.notify()
      }
    }, `convaxRenderer: creation ${definition.id}`)
    return () => { void remove() }
  }

  registerWorkspaceActions(actions: CanvasWorkspaceActions): () => void {
    const keys = Object.keys(actions)
    if (keys.some(key => Object.hasOwn(this.actions, key))) throw new Error('Convax workspace action already registered')
    const remove = this.ctx.effect(() => {
      this.actionOwners.add(actions)
      this.actions = [...this.actionOwners].reduce<CanvasWorkspaceActions>((combined, owner) => ({ ...combined, ...owner }), {})
      this.notify()
      return () => {
        if (!this.actionOwners.delete(actions)) return
        this.actions = [...this.actionOwners].reduce<CanvasWorkspaceActions>((combined, owner) => ({ ...combined, ...owner }), {})
        this.notify()
      }
    }, 'convaxRenderer: node workspace actions')
    return () => { void remove() }
  }

  /** @param ctx - Renderer context that owns the service. */
  constructor(ctx: Context) { super(ctx, 'convaxRenderer'); this.slots = ctx.slots }

  registerNodeRenderer(typeId: CanvasNodeTypeId, definition: CanvasNodeRendererDefinition): () => void {
    if (this.registrations.has(typeId)) throw new Error(`Convax node renderer already registered: ${typeId}`)
    const { dataVersion, component: Component } = definition
    const dispose = this.ctx.effect(() => {
      this.registrations.add(typeId)
      this.definitions.set(typeId, definition)
      this.notify()
      let remove: () => void
      try {
        remove = this.slots.inject('convax.node', () => this.slots.register({
          name: 'convax.node', key: typeId, locale: NS,
        }, (props: CanvasNodeRendererProps) => {
          if (props.node.dataVersion !== dataVersion) return <NodePlaceholder {...props} reason="rendererVersion" />
          return <Component {...props} />
        }))
      } catch (error) {
        this.registrations.delete(typeId)
        this.definitions.delete(typeId)
        this.notify()
        throw error
      }
      return () => { remove(); this.registrations.delete(typeId); this.definitions.delete(typeId); this.notify() }
    }, `convaxRenderer: ${typeId}`)
    return () => { void dispose() }
  }
}
