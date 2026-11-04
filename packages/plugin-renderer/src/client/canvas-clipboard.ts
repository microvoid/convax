/** Versioned canvas clipboard records contain graph data and geometry, never Chat Session bindings. */
import { z } from 'zod'
import type {
  CanvasConnection, CanvasConnectionId, CanvasData, CanvasDocument, CanvasNode, CanvasNodeId, CanvasNodeTypeId,
} from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { CanvasChatPresentation } from './props.ts'
import type { ResourceView } from './store.ts'
import { CHAT_MIN_HEIGHT, CHAT_MIN_WIDTH } from './chat-size.ts'
import { RESOURCE_CARD_WIDTH } from './placement.ts'

/** Measured border-box dimensions retained for collision-aware placement. */
export interface ClipboardNodeSize {
  readonly width: number
  readonly height: number
}

/** Safe window preferences that reproduce a copied card without carrying conversation state. */
export type CanvasClipboardView =
  | { readonly kind: 'chat'; readonly presentation: CanvasChatPresentation }
  | { readonly kind: 'resource'; readonly presentation: ResourceView }
  | { readonly kind: 'default' }

/** Tagged text clipboard protocol; external text must pass the complete parser before paste. */
export interface CanvasClipboardPayload {
  readonly kind: 'convax.canvas.nodes'
  readonly version: 1
  readonly nodes: readonly CanvasNode[]
  readonly connections: readonly CanvasConnection[]
  readonly dimensions: Readonly<Record<string, ClipboardNodeSize>>
  readonly views: Readonly<Record<string, CanvasClipboardView>>
}

/** Workspace-owned feedback remains visible when a canvas tab changes. */
export type CanvasClipboardNotice = 'clipboard.copied' | 'clipboard.copyFailed' | 'clipboard.readFailed' | 'clipboard.invalid' | 'clipboard.changed'

const id = z.string().min(1)
const point = z.object({ x: z.number(), y: z.number() })
const nodeSchema: z.ZodType<CanvasNode> = z.object({
  id: id.transform(value => value as CanvasNodeId), typeId: id.transform(value => value as CanvasNodeTypeId),
  dataVersion: z.number().int().nonnegative(), data: z.record(z.string(), z.json()), position: point,
  revision: z.number().int().nonnegative(),
}).strict()
const connectionSchema: z.ZodType<CanvasConnection> = z.object({
  id: id.transform(value => value as CanvasConnectionId), source: id.transform(value => value as CanvasNodeId), sourcePort: id,
  target: id.transform(value => value as CanvasNodeId), targetPort: id, purpose: z.enum(['input', 'delivery']),
}).strict()
const viewSchema: z.ZodType<CanvasClipboardView> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), presentation: z.object({
    collapsed: z.boolean(),
    size: z.object({ width: z.number().min(CHAT_MIN_WIDTH), height: z.number().min(CHAT_MIN_HEIGHT) }).strict().optional(),
    toolWidths: z.object({ normal: z.number().positive().optional(), fullscreen: z.number().positive().optional() }).strict().optional(),
  }).strict().transform(value => ({ collapsed: value.collapsed,
    ...(value.size === undefined ? {} : { size: value.size }),
    ...(value.toolWidths === undefined ? {} : { toolWidths: {
      ...(value.toolWidths.normal === undefined ? {} : { normal: value.toolWidths.normal }),
      ...(value.toolWidths.fullscreen === undefined ? {} : { fullscreen: value.toolWidths.fullscreen }),
    } }),
  })) }).strict(),
  z.object({ kind: z.literal('resource'), presentation: z.object({
    expanded: z.boolean(), width: z.number().min(RESOURCE_CARD_WIDTH).optional(), height: z.number().positive().optional(),
  }).strict().transform(value => ({ expanded: value.expanded,
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
  })) }).strict(),
  z.object({ kind: z.literal('default') }).strict(),
])
const clipboardSchema: z.ZodType<CanvasClipboardPayload> = z.object({
  kind: z.literal('convax.canvas.nodes'), version: z.literal(1), nodes: z.array(nodeSchema).min(1),
  connections: z.array(connectionSchema),
  dimensions: z.record(z.string(), z.object({ width: z.number().positive(), height: z.number().positive() })),
  views: z.record(z.string(), viewSchema),
}).strict().superRefine((value, context) => {
  const nodes = new Set(value.nodes.map(node => node.id))
  const edges = new Set(value.connections.map(edge => edge.id))
  if (nodes.size !== value.nodes.length || edges.size !== value.connections.length) {
    context.addIssue({ code: 'custom', message: 'Clipboard identities are duplicated' })
  }
  for (const node of value.nodes) {
    const expected = node.typeId === 'convax.chat' ? 'chat' : node.typeId === 'convax.file' || node.typeId === 'convax.folder' ? 'resource' : 'default'
    if (!Object.hasOwn(value.views, node.id) || value.views[node.id]?.kind !== expected) {
      context.addIssue({ code: 'custom', message: 'Clipboard node presentation is missing or incompatible' })
    }
    const size = Object.hasOwn(value.dimensions, node.id) ? value.dimensions[node.id] : undefined
    if (size === undefined) context.addIssue({ code: 'custom', message: 'Clipboard node dimensions are missing' })
    else {
      if (!Number.isFinite(node.position.x + size.width) || !Number.isFinite(node.position.y + size.height)) {
        context.addIssue({ code: 'custom', message: 'Clipboard node geometry is not finite' })
      }
    }
  }
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const node of value.nodes) {
    const size = Object.hasOwn(value.dimensions, node.id) ? value.dimensions[node.id] : undefined
    if (size === undefined) continue
    left = Math.min(left, node.position.x)
    top = Math.min(top, node.position.y)
    right = Math.max(right, node.position.x + size.width)
    bottom = Math.max(bottom, node.position.y + size.height)
  }
  if (!Number.isFinite(right - left) || !Number.isFinite(bottom - top)) {
    context.addIssue({ code: 'custom', message: 'Clipboard selection geometry is not finite' })
  }
  for (const edge of value.connections) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) context.addIssue({ code: 'custom', message: 'Clipboard connection leaves its selection' })
  }
})

/**
 * Retain provider data while limiting Chat copies to their name and working directory.
 * @param node - Committed graph node to copy.
 * @returns Independent JSON fields without Chat bindings, drafts or thread history.
 */
export function clipboardNodeData(node: CanvasNode): CanvasData {
  if (node.typeId !== 'convax.chat') return structuredClone(node.data)
  const data: CanvasData = {}
  if (typeof node.data.title === 'string') data.title = node.data.title
  if (node.data.defaultTitle === true) data.defaultTitle = true
  if (typeof node.data.cwd === 'string') data.cwd = node.data.cwd
  return data
}

/**
 * Copy selected nodes and only connections whose two endpoints are selected.
 * @param document - Current committed graph.
 * @param selection - Node identities chosen by the user.
 * @param dimensions - Resolved measured dimensions for the copied nodes.
 * @param views - Safe window preferences for each selected card.
 * @returns A detached protocol payload, or null for an empty selection.
 */
export function copyCanvasSelection(
  document: CanvasDocument, selection: readonly CanvasNodeId[], dimensions: Readonly<Record<string, ClipboardNodeSize>>,
  views: Readonly<Record<string, CanvasClipboardView>>,
): CanvasClipboardPayload | null {
  const selected = new Set(selection)
  const nodes = document.nodes.filter(node => selected.has(node.id)).map(node => ({ ...node,
    data: clipboardNodeData(node), position: { ...node.position },
  }))
  if (nodes.length === 0) return null
  const retained = new Set<string>(nodes.map(node => node.id))
  return { kind: 'convax.canvas.nodes', version: 1, nodes,
    connections: document.connections.filter(edge => retained.has(edge.source) && retained.has(edge.target)).map(edge => ({ ...edge })),
    dimensions: Object.fromEntries(Object.entries(dimensions).filter(([id]) => retained.has(id)).map(([id, size]) => [id, { ...size }])),
    views: Object.fromEntries(Object.entries(views).filter(([id]) => retained.has(id)).map(([id, view]) => [id, structuredClone(view)])),
  }
}

/**
 * Validate clipboard text from another process before exposing any graph operations.
 * @param text - System clipboard text; ordinary text and unsupported versions are ignored.
 * @returns A validated canvas payload, or null when it is not this graph protocol.
 */
export function parseCanvasClipboard(text: string): CanvasClipboardPayload | null {
  let value: unknown
  try { value = JSON.parse(text) }
  catch (_invalidJson) { return null }
  const result = clipboardSchema.safeParse(value)
  return result.success ? result.data : null
}
