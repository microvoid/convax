/** Durable Convax records and the explicit repository upgrade chain. */
import { z } from 'zod'
import { isAbsolute } from 'node:path'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { CanvasDelta } from './history-delta.ts'
import type {
  CanvasConnection, CanvasData, CanvasDocument, CanvasId, CanvasNode,
  CanvasNodeId, CanvasNodeTypeId, CanvasConnectionId, CanvasOperationId, CanvasDeliveryId,
  CanvasCommandRequest, CanvasThreadRequest, CanvasMigrationId,
  CanvasGraphOperation, CanvasCommitRequest,
} from './types.ts'

const point = z.object({ x: z.number(), y: z.number() })
const sessionId = z.string().min(1).transform(value => value as SessionId)
const canvasId = z.string().min(1).transform(value => value as CanvasId)
const nodeId = z.string().min(1).transform(value => value as CanvasNodeId)
const data: z.ZodType<CanvasData> = z.record(z.string(), z.json())
const node: z.ZodType<CanvasNode> = z.object({
  id: z.string().min(1).transform(v => v as CanvasNodeId),
  typeId: z.string().min(1).transform(v => v as CanvasNodeTypeId),
  dataVersion: z.number().int().nonnegative(), data, position: point,
  revision: z.number().int().nonnegative(),
})
const connection = z.object({
  id: z.string().min(1).transform(v => v as CanvasConnectionId),
  source: z.string().min(1).transform(v => v as CanvasNodeId), sourcePort: z.string().min(1),
  target: z.string().min(1).transform(v => v as CanvasNodeId), targetPort: z.string().min(1),
  purpose: z.enum(['input', 'delivery']),
}) satisfies z.ZodType<CanvasConnection>
const canvas: z.ZodType<CanvasDocument> = z.object({
  id: z.string().min(1).transform(v => v as CanvasId), title: z.string().trim().min(1),
  archived: z.boolean().optional(),
  revision: z.number().int().nonnegative(), nodes: z.array(node), connections: z.array(connection),
}).transform(({ archived, ...document }) => ({ ...document, ...(archived === undefined ? {} : { archived }) }))

/** Wire and durable validation of sequential graph operations. */
export const canvasGraphOperationSchema: z.ZodType<CanvasGraphOperation> = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('canvas.add'), title: z.string() }),
  z.strictObject({ op: z.literal('canvas.set'), title: z.string() }),
  z.strictObject({ op: z.literal('canvas.remove') }),
  z.strictObject({ op: z.literal('node.add'), id: nodeId,
    typeId: z.string().min(1).transform(value => value as CanvasNodeTypeId),
    dataVersion: z.number().int().nonnegative(), data, position: point }),
  z.strictObject({ op: z.literal('node.set'), id: nodeId, ifRevision: z.number().int().positive().optional(),
    dataVersion: z.number().int().nonnegative().optional(), data: data.optional(), position: point.optional() }),
  z.strictObject({ op: z.literal('node.remove'), id: nodeId }),
  z.strictObject({ op: z.literal('edge.add'), ...connection.shape }),
  z.strictObject({ op: z.literal('edge.remove'), id: z.string().min(1).transform(value => value as CanvasConnectionId) }),
  z.strictObject({ op: z.literal('history'), targetOperationId: z.string().min(1).transform(value => value as CanvasOperationId), direction: z.enum(['undo', 'redo']) }),
])

/** Public batch requests are validated before resource reads or durable coordination. */
export const canvasCommitRequestSchema: z.ZodType<CanvasCommitRequest> = z.strictObject({
  canvasId, operationId: z.string().min(1).transform(value => value as CanvasOperationId),
  expectedRevision: z.number().int().nonnegative(), confirmed: z.boolean().optional(),
  ops: z.array(canvasGraphOperationSchema).min(1),
}).refine(request => request.ops.every(op => op.op !== 'history') || request.ops.length === 1, 'History must be submitted alone')

/** Runtime validation of graph requests retained in operation receipts. */
export const canvasCommandRequestSchema: z.ZodType<CanvasCommandRequest> = z.object({
  canvasId, operationId: z.string().min(1).transform(value => value as CanvasOperationId),
  expectedRevision: z.number().int().nonnegative(), confirmed: z.boolean().optional(),
  command: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), title: z.string() }),
    z.object({ kind: z.literal('rename'), title: z.string() }),
    z.object({ kind: z.literal('delete') }),
    z.object({ kind: z.literal('set-archived'), archived: z.boolean() }),
    z.object({ kind: z.literal('duplicate'), newCanvasId: canvasId, title: z.string() }),
    z.object({ kind: z.literal('purge') }),
    z.object({ kind: z.literal('add-node'), node, initialConnections: z.array(connection).optional() }),
    z.object({ kind: z.literal('add-subgraph'), nodes: z.array(node), connections: z.array(connection) }),
    z.object({ kind: z.literal('move-nodes'), nodes: z.array(z.object({ id: nodeId, position: point })) }),
    z.object({ kind: z.literal('arrange-nodes'), nodeIds: z.array(nodeId), origin: point,
      columns: z.number().int().min(1), columnGap: z.number().positive(), rowGap: z.number().positive() }),
    z.object({ kind: z.literal('remove-nodes'), nodeIds: z.array(nodeId) }),
    z.object({ kind: z.literal('update-node'), nodeId, dataVersion: z.number().int().nonnegative(), data }),
    z.object({ kind: z.literal('add-connection'), connection }),
    z.object({ kind: z.literal('remove-connections'), connectionIds: z.array(z.string().min(1).transform(value => value as CanvasConnectionId)) }),
    z.object({ kind: z.literal('history'), targetOperationId: z.string().min(1).transform(value => value as CanvasOperationId), direction: z.enum(['undo', 'redo']) }),
    z.object({ kind: z.literal('batch'), ops: z.array(canvasGraphOperationSchema).min(1) }),
  ]),
})

/** Runtime validation of immutable creation intentions before recovery. */
export const threadRequestSchema: z.ZodType<CanvasThreadRequest> = z.intersection(z.object({
  canvasId, nodeId, expectedRevision: z.number().int().nonnegative(),
  operationId: z.string().min(1).transform(value => value as CanvasOperationId),
}), z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), cwd: z.string().optional(), agentPreset: z.string().min(1).optional() }),
  z.object({ kind: z.literal('fork'), sourceSessionId: sessionId, atSeq: z.number().int().nonnegative().transform(value => value as SessionSeq).optional(),
    agentPreset: z.never().optional() }),
]))

function requestText(schema: z.ZodType) {
  return z.string().refine((value) => {
    try { return schema.safeParse(JSON.parse(value)).success } catch (_invalidJson) { return false }
  }, 'Persisted operation request is invalid')
}

/** Authoritative graph records; runtime provider availability is not stored. */
export const graphSchema = z.object({
  revision: z.number().int().nonnegative(), canvases: z.array(canvas),
}).superRefine((graph, context) => {
  const canvasIds = new Set<CanvasId>()
  const nodeIds = new Set<CanvasNodeId>()
  const connectionIds = new Set<CanvasConnectionId>()
  graph.canvases.forEach((document, canvasIndex) => {
    if (canvasIds.has(document.id)) {
      context.addIssue({ code: 'custom', path: ['canvases', canvasIndex, 'id'], message: 'Canvas identity is duplicated' })
    }
    canvasIds.add(document.id)
    const localNodes = new Set(document.nodes.map(entry => entry.id))
    document.nodes.forEach((entry, nodeIndex) => {
      if (nodeIds.has(entry.id)) {
        context.addIssue({ code: 'custom', path: ['canvases', canvasIndex, 'nodes', nodeIndex, 'id'], message: 'Node identity is duplicated' })
      }
      nodeIds.add(entry.id)
    })
    document.connections.forEach((edge, edgeIndex) => {
      if (connectionIds.has(edge.id)) {
        context.addIssue({ code: 'custom', path: ['canvases', canvasIndex, 'connections', edgeIndex, 'id'], message: 'Connection identity is duplicated' })
      }
      connectionIds.add(edge.id)
      if (!localNodes.has(edge.source) || !localNodes.has(edge.target)) {
        context.addIssue({ code: 'custom', path: ['canvases', canvasIndex, 'connections', edgeIndex], message: 'Connection endpoint is absent from its canvas' })
      }
    })
  })
})

/** Receipt stores request equality and commit position rather than copies of old graphs. */
export const operationSchema = z.object({
  request: requestText(canvasCommandRequestSchema), revision: z.number().int().nonnegative(),
})

/** Session ownership survives missing providers and closed views. */
export const bindingSchema = z.object({
  canvasId, nodeId, sessionId, parentSessionId: sessionId.nullable(),
  inheritedEventCount: z.number().int().nonnegative(),
  deliveryCursor: z.number().int().min(-1).default(-1),
  deliveryError: z.string().nullable().default(null),
  ordinal: z.number().int().nonnegative().default(0),
})

/** Fixed Session identity and materialization outcome retained with its Chat operation. */
export const sessionReservationSchema = z.object({
  phase: z.enum(['reserved', 'completed']), sessionId,
  createdAt: z.number().int().nonnegative(), cwd: z.string().refine(isAbsolute, 'An absolute project directory is required'),
  agentPreset: z.string().optional(), boundary: z.number().int().nonnegative().optional(),
})

/** Intent precedes every external Session creation or fork. */
export const threadOperationSchema = z.object({
  request: requestText(threadRequestSchema), canvasId, nodeId, cwd: z.string(),
  phase: z.enum(['pending', 'bound', 'suppressed']),
  sessionId: sessionId.nullable(), parentSessionId: sessionId.nullable(),
  inheritedEventCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  session: sessionReservationSchema.optional(),
})

/** A deletion retains all targets until every Session has stopped and archived. */
export const deletionSchema = z.object({
  request: requestText(canvasCommandRequestSchema), canvasId, nodeIds: z.array(nodeId),
  phase: z.enum(['deleting', 'completed']),
  error: z.string().nullable(),
  restoreSessions: z.array(sessionId).default([]),
})

const historyData = z.object({ dataVersion: z.number().int().nonnegative(), data })
const nodeChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('added'), node, index: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('removed'), node, index: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('updated'), nodeId, typeId: z.string().min(1).transform(value => value as CanvasNodeTypeId),
    position: z.object({ before: point, after: point }).optional(), data: z.object({ before: historyData, after: historyData }).optional(),
  }).transform(value => ({ kind: value.kind, nodeId: value.nodeId, typeId: value.typeId,
    ...(value.position === undefined ? {} : { position: value.position }), ...(value.data === undefined ? {} : { data: value.data }),
  })),
])

/** Field-level effects captured from Host commits rather than supplied by clients. */
export const canvasDeltaSchema: z.ZodType<CanvasDelta> = z.object({
  title: z.object({ before: z.string(), after: z.string() }).optional(), nodes: z.array(nodeChange),
  connections: z.array(z.object({ kind: z.enum(['added', 'removed']), connection, index: z.number().int().nonnegative() })),
}).transform(value => ({
  nodes: value.nodes, connections: value.connections, ...(value.title === undefined ? {} : { title: value.title }),
}))

/** Reversible graph effects and the archive changes made by the last removal. */
export const historySchema = z.object({ canvasId, delta: canvasDeltaSchema, applied: z.boolean(), restoreSessions: z.array(sessionId),
  revision: z.number().int().positive().optional(),
  lifecycle: z.object({ before: canvas.nullable(), after: canvas.nullable() }).optional(),
})

/** Restoring a Chat keeps admission blocked until its native archive changes settle. */
export const restorationSchema = z.object({
  request: requestText(canvasCommandRequestSchema), canvasId, nodeIds: z.array(nodeId), sessionIds: z.array(sessionId),
  phase: z.enum(['restoring', 'completed']), error: z.string().nullable(),
})

/** Per-file projection receipts preserve intentional reference removal during replay. */
export const deliverySchema = z.object({
  sessionId, seq: z.number().int().nonnegative(), index: z.number().int().nonnegative(),
  canvasId, nodeId,
  outputId: nodeId,
  phase: z.enum(['projected', 'removed', 'suppressed']),
})

/** Recoverable original payload and accepted successor committed with the graph. */
export const nodeMigrationSchema = z.object({
  canvasId, nodeId, typeId: z.string().min(1).transform(value => value as CanvasNodeTypeId),
  sourceVersion: z.number().int().nonnegative(), targetVersion: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative(), resultRevision: z.number().int().nonnegative(),
  sourceData: data, resultData: data,
})

/** Durable tables owned exclusively by the Convax repository. */
export const canvasTables = {
  directories: z.object({ path: z.string().refine(isAbsolute, 'An absolute canvas directory is required') }),
  operations: operationSchema,
  bindings: bindingSchema,
  thread_operations: threadOperationSchema,
  deletions: deletionSchema,
  deliveries: deliverySchema,
  node_migrations: nodeMigrationSchema,
  history: historySchema,
  node_revisions: z.object({ revision: z.number().int().nonnegative() }),
  retired_connections: z.object({ retired: z.literal(true) }),
  restorations: restorationSchema,
} as const

/** Branded record identities for each persisted table. */
export interface CanvasTableKeys {
  directories: CanvasId
  operations: CanvasOperationId
  bindings: SessionId
  thread_operations: CanvasOperationId
  deletions: CanvasOperationId
  deliveries: CanvasDeliveryId
  node_migrations: CanvasMigrationId
  history: CanvasOperationId
  node_revisions: CanvasNodeId
  retired_connections: CanvasConnectionId
  restorations: CanvasOperationId
}

/** Validated record type selected by its owning table. */
export type CanvasTableValue<N extends keyof typeof canvasTables> = z.infer<(typeof canvasTables)[N]>

/** Current Convax repository schema, independent of DSH storage formats. */
export const CANVAS_SCHEMA_VERSION = 7
