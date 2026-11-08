/** Canvas-owned grouping commands and window-measured group geometry. */
import type {
  CanvasCommand, CanvasDocument, CanvasGroup, CanvasGroupColor, CanvasGroupId, CanvasNodeId, CanvasPoint,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import { createCanvasSnapGesture, snapCanvasDrag, type SnapNodeBounds } from './canvas-snapping.ts'

/** Node and group identities explicitly selected in this window. */
export interface CanvasSelection {
  readonly nodeIds: readonly CanvasNodeId[]
  readonly groupIds: readonly CanvasGroupId[]
}

/** A group's current window bounds; card expansion never changes its durable membership. */
export interface CanvasGroupBounds extends CanvasGroup, CanvasPoint {
  readonly width: number
  readonly height: number
  readonly nodeIds: readonly CanvasNodeId[]
}

/** Resolve each selected node once, including members of selected groups. */
export function canvasSelectionMembers(document: CanvasDocument, selection: CanvasSelection): CanvasNodeId[] {
  const nodes = new Set(selection.nodeIds)
  const groups = new Set(selection.groupIds)
  return document.nodes.filter(node => nodes.has(node.id) || node.groupId !== undefined && groups.has(node.groupId)).map(node => node.id)
}

/** Derive padded frames from the current window's card dimensions and positions. */
export function canvasGroupBounds(document: CanvasDocument, geometry: readonly SnapNodeBounds[]): CanvasGroupBounds[] {
  const measured = new Map(geometry.map(node => [node.id, node]))
  return (document.groups ?? []).flatMap((group) => {
    const members = document.nodes.filter(node => node.groupId === group.id).flatMap(node => measured.get(node.id) ?? [])
    if (members.length === 0) return []
    const x = Math.min(...members.map(node => node.x)) - 24
    const y = Math.min(...members.map(node => node.y)) - 52
    return [{ ...group, x, y, width: Math.max(...members.map(node => node.x + node.width)) + 24 - x,
      height: Math.max(...members.map(node => node.y + node.height)) + 24 - y, nodeIds: members.map(node => node.id) }]
  })
}

/** One rigid drag previews world positions and commits one movement command. */
export class CanvasGroupDrag {
  private readonly gesture
  private readonly anchor: SnapNodeBounds
  private readonly original: ReadonlyMap<CanvasNodeId, CanvasPoint>
  private delta: CanvasPoint = { x: 0, y: 0 }

  constructor(document: CanvasDocument, readonly selection: CanvasSelection,
    geometry: readonly SnapNodeBounds[], frames: readonly CanvasGroupBounds[]) {
    const memberIds = new Set(canvasSelectionMembers(document, selection))
    this.original = new Map(document.nodes.filter(node => memberIds.has(node.id)).map(node => [node.id, node.position]))
    const selectedGroups = new Set(selection.groupIds)
    const groupedMembers = new Set(frames.flatMap(frame => frame.nodeIds))
    const moving = [
      ...frames.filter(frame => selectedGroups.has(frame.id)),
      ...geometry.filter(node => selection.nodeIds.includes(node.id)
        && !document.nodes.some(member => member.id === node.id && member.groupId !== undefined && selectedGroups.has(member.groupId))),
    ]
    const x = Math.min(...moving.map(node => node.x))
    const y = Math.min(...moving.map(node => node.y))
    const identities = new Set<string>([...document.nodes.map(node => node.id), ...frames.map(frame => frame.id)])
    let proxyId = 'group-selection'
    while (identities.has(proxyId)) proxyId += '-'
    const proxy: SnapNodeBounds = { id: proxyId as CanvasNodeId, x, y,
      width: Math.max(...moving.map(node => node.x + node.width)) - x,
      height: Math.max(...moving.map(node => node.y + node.height)) - y }
    this.anchor = proxy
    const candidates: SnapNodeBounds[] = [
      ...geometry.filter(node => !memberIds.has(node.id) && !groupedMembers.has(node.id)),
      ...frames.filter(frame => !selectedGroups.has(frame.id) && !frame.nodeIds.some(id => memberIds.has(id)))
        .map(frame => ({ ...frame, id: frame.id as unknown as CanvasNodeId })),
    ]
    this.gesture = createCanvasSnapGesture([proxy, ...candidates], new Set([proxy.id]))
  }

  /** Preview a shared delta, snapping the selection's outer frame in screen pixels. */
  preview(delta: CanvasPoint, zoom: number) {
    const result = snapCanvasDrag(this.gesture, delta, zoom)
    const position = result.positions.get(this.anchor.id)
    if (position === undefined) throw new Error('Group drag is missing its selection bounds')
    this.delta = { x: position.x - this.anchor.x, y: position.y - this.anchor.y }
    return { positions: Object.fromEntries([...this.original].map(([id, point]) => [id, {
      x: point.x + this.delta.x, y: point.y + this.delta.y,
    }])), guides: result.guides }
  }

  /** Retain the final snapped displacement for one Host transaction. */
  command(): CanvasCommand | null {
    return this.delta.x === 0 && this.delta.y === 0 ? null : { kind: 'move-selection',
      nodeIds: [...this.selection.nodeIds], groupIds: [...this.selection.groupIds], delta: this.delta }
  }
}

/** Own group workflows independently of React's rendering and pointer lifetimes. */
export class CanvasGroupingController {
  private coloring = false
  constructor(private readonly options: {
    readonly document: () => CanvasDocument
    readonly command: (command: CanvasCommand) => Promise<boolean>
    readonly newId: () => CanvasGroupId
  }) {}

  /** Expand explicit group identities and selected nodes without duplicate members. */
  members(selection: CanvasSelection): CanvasNodeId[] { return canvasSelectionMembers(this.options.document(), selection) }

  /** Treat a complete member selection as its existing group. */
  selectedGroups(selection: CanvasSelection): CanvasGroupId[] {
    const document = this.options.document()
    return (document.groups ?? []).filter(group => selection.groupIds.includes(group.id)
      || document.nodes.some(node => node.groupId === group.id)
        && document.nodes.filter(node => node.groupId === group.id).every(node => selection.nodeIds.includes(node.id)))
      .map(group => group.id)
  }

  /** Preserve an existing group's identity when its complete contents are selected alone. */
  canGroup(selection: CanvasSelection): boolean {
    const document = this.options.document()
    const members = this.members(selection)
    if (members.length < 2) return false
    return !(document.groups ?? []).some((group) => {
      const existing = document.nodes.filter(node => node.groupId === group.id)
      return existing.length === members.length && existing.every(node => members.includes(node.id))
    })
  }

  /** Create one structural group only when the selected contents need a new identity. */
  async group(selection: CanvasSelection, title: string): Promise<CanvasGroupId | null> {
    const nodeIds = this.members(selection)
    if (!this.canGroup(selection)) return null
    const id = this.options.newId()
    return await this.options.command({ kind: 'group-nodes', group: { id, title }, nodeIds }) ? id : null
  }

  /** Commit the edited name through the canvas's command owner. */
  rename(groupId: CanvasGroupId, title: string): Promise<boolean> {
    return this.options.command({ kind: 'rename-group', groupId, title: title.trim() })
  }

  /** Read a shared saved color, distinguishing different colors from the default. */
  color(groupIds: readonly CanvasGroupId[]): CanvasGroupColor | null | 'mixed' {
    const groups = this.options.document().groups?.filter(group => groupIds.includes(group.id)) ?? []
    const color = groups[0]?.color ?? null
    return groups.every(group => (group.color ?? null) === color) ? color : 'mixed'
  }

  /** Apply one color transaction; unchanged colors and overlapping submissions create no history. */
  async setColor(groupIds: readonly CanvasGroupId[], color: CanvasGroupColor | null): Promise<boolean> {
    if (this.coloring) return false
    const ids = [...new Set(groupIds)]
    const groups = this.options.document().groups ?? []
    if (ids.length === 0 || ids.some(id => !groups.some(group => group.id === id))) return false
    if (ids.every(id => (groups.find(group => group.id === id)?.color ?? null) === color)) return true
    this.coloring = true
    try { return await this.options.command({ kind: 'set-group-color', groupIds: ids, color }) }
    finally { this.coloring = false }
  }

  /** Remove group containers while preserving their cards and world positions. */
  ungroup(groupIds: readonly CanvasGroupId[]): Promise<boolean> {
    return this.options.command({ kind: 'ungroup', groupIds: [...groupIds] })
  }

  /** Explicitly move the selected contents into or out of a group. */
  assign(selection: CanvasSelection, groupId: CanvasGroupId | null): Promise<boolean> {
    return this.options.command({ kind: 'set-node-group', nodeIds: this.members(selection), groupId })
  }

  /** Let the Host expand groups and coordinate deletion with Chat lifecycles. */
  remove(selection: CanvasSelection): Promise<boolean> {
    return this.options.command({ kind: 'remove-selection', nodeIds: [...selection.nodeIds], groupIds: [...selection.groupIds] })
  }

  /** Apply a shared displacement once even when groups and their members overlap. */
  move(selection: CanvasSelection, delta: CanvasPoint): Promise<boolean> {
    return this.options.command({ kind: 'move-selection', nodeIds: [...selection.nodeIds], groupIds: [...selection.groupIds], delta })
  }
}
