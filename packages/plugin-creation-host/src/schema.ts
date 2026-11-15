/** Validated graph, request and durable job formats for Creation. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { CredentialKey, CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type { CanvasId, CanvasNodeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { AssetId, AssetView, ConnectionId, ConnectionInspection, ConnectionSnapshot, CreationRoute, GenerateInput, JobId, OperationId, ProviderId, ProviderOutput, ProviderRequest, WorkbenchData, WorkbenchRef } from './types.ts'

const id = <T extends string>() => z.string().min(1).transform(value => value as T)
export const jsonObject = z.record(z.string(), z.json())
export const mediaKind = z.enum(['image', 'video', 'audio'])
export const workbenchRef = z.object({ canvasId: id<CanvasId>(), nodeId: id<CanvasNodeId>() })
const route = z.strictObject({ connectionId: id<ConnectionId>(), modelId: z.string().min(1).optional(), defaults: jsonObject.optional() })
  .transform((value): CreationRoute => ({ connectionId: value.connectionId,
    ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
    ...(value.defaults === undefined ? {} : { defaults: value.defaults }) }))
export const workbenchData = z.strictObject({ title: z.string().trim().min(1).max(200), routes: z.strictObject({
  image: route.optional(), video: route.optional(), audio: route.optional(),
}) }).transform((value): WorkbenchData => ({ title: value.title, routes: {
  ...(value.routes.image === undefined ? {} : { image: value.routes.image }),
  ...(value.routes.video === undefined ? {} : { video: value.routes.video }),
  ...(value.routes.audio === undefined ? {} : { audio: value.routes.audio }),
} }))
export const generateInput = z.strictObject({
  kind: mediaKind, prompt: z.string().trim().min(1).max(32_000),
  references: z.array(z.strictObject({
    source: z.union([z.strictObject({ assetId: id<AssetId>() }), z.strictObject({ path: z.string().min(1) })]),
    role: z.string().min(1),
  })).max(32).optional(), parameters: jsonObject.optional(),
}).transform((value): GenerateInput => ({ kind: value.kind, prompt: value.prompt,
  ...(value.references === undefined ? {} : { references: value.references }),
  ...(value.parameters === undefined ? {} : { parameters: value.parameters }) }))
export const saveConnectionInput = z.strictObject({
  ref: workbenchRef,
  connection: z.strictObject({ id: id<ConnectionId>().optional(), providerId: id<ProviderId>(), label: z.string().trim().min(1).max(200),
    settings: jsonObject, credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional() }),
  apiKey: z.string().min(1).max(16_384).optional(),
})
export const connectAndApplyInput = saveConnectionInput.extend({
  expectedRevision: z.number().int().nonnegative(), operationId: id<CanvasOperationId>(), data: workbenchData.optional(),
  targetKind: mediaKind.optional(),
})
const connectionSnapshot = z.object({
  id: id<ConnectionId>(), providerId: id<ProviderId>(), revision: z.number().int().positive(),
  accountBinding: z.string(), settings: jsonObject,
  credential: z.union([z.object({ kind: z.literal('env'), ref: id<CredentialRef>() }), z.object({ kind: z.literal('record'), key: id<CredentialKey>() })]).optional(),
})
const connectionBase = connectionSnapshot.extend({ owner: workbenchRef, label: z.string() }).transform(value => ({
  ...normalizeConnection(value), owner: value.owner, label: value.label,
}))
const readyInspection = z.object({
  state: z.literal('ready'),
  capabilities: z.array(z.object({
    kind: mediaKind, modelId: z.string().optional(), modelLabel: z.string().optional(), parameterSchema: jsonObject,
    inputs: z.array(z.object({ role: z.string(), kinds: z.array(mediaKind), minItems: z.number(), maxItems: z.number() })),
    maxOutputs: z.number() })),
  submissionRecovery: z.enum(['idempotency-key', 'recoverable-resource', 'unsupported']),
  cancellation: z.enum(['supported', 'best-effort', 'unsupported']),
}).transform((value): Extract<ConnectionInspection, { state: 'ready' }> => ({ ...value,
  capabilities: value.capabilities.map(({ modelId, modelLabel, ...capability }) => ({ ...capability,
    ...(modelId === undefined ? {} : { modelId }), ...(modelLabel === undefined ? {} : { modelLabel }) })),
}))
const applicationRecord = z.object({
  phase: z.enum(['staged', 'applied']),
  operationId: id<CanvasOperationId>(), fingerprint: z.string(), expectedRevision: z.number().int().nonnegative(),
  data: workbenchData, inspection: readyInspection, applied: z.array(mediaKind),
  previous: connectionBase.optional(),
})
const connectionRecord = connectionSnapshot.extend({ owner: workbenchRef, label: z.string(), application: applicationRecord.optional() })
  .transform((value): ConnectionRecord => {
    const record = { ...normalizeConnection(value), owner: value.owner, label: value.label }
    if (value.application === undefined) return record
    const { previous, ...application } = value.application
    return { ...record, application: { ...application, ...(previous === undefined ? {} : { previous }) } }
  })
function normalizeConnection(value: z.infer<typeof connectionSnapshot>): ConnectionSnapshot {
  return { id: value.id, providerId: value.providerId, revision: value.revision,
    accountBinding: value.accountBinding, settings: value.settings,
    ...(value.credential === undefined ? {} : { credential: value.credential }) }
}
/** A staged connection becomes visible only when its graph operation has committed. */
export interface ConnectionRecord extends ConnectionSnapshot {
  owner: WorkbenchRef
  label: string
  application?: {
    phase: 'staged' | 'applied'
    operationId: CanvasOperationId
    fingerprint: string
    expectedRevision: number
    data: WorkbenchData
    inspection: Extract<ConnectionInspection, { state: 'ready' }>
    applied: ('image' | 'video' | 'audio')[]
    previous?: ConnectionSnapshot & { owner: WorkbenchRef; label: string }
  }
}
const issue = z.object({
  stage: z.enum(['configuration', 'submission', 'generation', 'materialization', 'publication', 'projection', 'cancellation']),
  code: z.string(), message: z.string(),
  recovery: z.enum(['check-status', 'retry-transfer', 'retry-publication', 'retry-projection', 'retry-cancellation', 'configure-provider', 'new-generation', 'none']),
})
const cancellation = z.object({ jobId: id<JobId>(), futureDelivery: z.enum(['suppressed', 'already-settled']), provider: z.union([
  z.object({ state: z.enum(['requested', 'confirmed', 'unsupported', 'already-terminal']) }),
  z.object({ state: z.enum(['unknown', 'failed']), issue }),
]) })
const output = z.object({ outputId: z.string().min(1), kind: mediaKind, locator: jsonObject, suggestedFilename: z.string().optional() })
  .transform((value): ProviderOutput => ({ outputId: value.outputId, kind: value.kind, locator: value.locator,
    ...(value.suggestedFilename === undefined ? {} : { suggestedFilename: value.suggestedFilename }) }))
const file = z.object({ path: z.string(), mimeType: z.string(), bytes: z.number().nonnegative(),
  width: z.number().optional(), height: z.number().optional(), durationSeconds: z.number().optional() })
  .transform((value): NonNullable<AssetView['file']> => ({ path: value.path, mimeType: value.mimeType, bytes: value.bytes,
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
    ...(value.durationSeconds === undefined ? {} : { durationSeconds: value.durationSeconds }) }))
export const jobRecord = z.object({
  id: id<JobId>(), operationId: id<OperationId>(), input: generateInput,
  admittedAt: z.number().int().nonnegative().optional(),
  origin: z.object({ canvasId: id<CanvasId>(), chatNodeId: id<CanvasNodeId>(), workbenchNodeId: id<CanvasNodeId>(),
    sessionId: id<SessionId>(), turn: z.number().int().nonnegative(), callId: id<ToolCallId>() }),
  connection: connectionSnapshot.transform(normalizeConnection),
  request: z.object({ kind: mediaKind, prompt: z.string(), modelId: z.string().optional(), parameters: jsonObject,
    references: z.array(z.object({ role: z.string(), path: z.string(), kind: mediaKind, mimeType: z.string() })) })
    .transform((value): ProviderRequest => ({ kind: value.kind, prompt: value.prompt, parameters: value.parameters,
      references: value.references,
      ...(value.modelId === undefined ? {} : { modelId: value.modelId }) })),
  directory: z.string(),
  maxOutputs: z.number().int().positive().max(128).default(32),
  state: z.enum(['queued', 'submitting', 'running', 'reconciling', 'awaiting-approval', 'approving', 'materializing', 'publishing', 'completed', 'failed', 'cancelled', 'blocked']),
  approval: z.object({ quoteId: z.string().min(1), credits: z.number().nonnegative(), unit: z.literal('credits'), message: z.string() }).optional(),
  approvedCredits: z.number().nonnegative().optional(),
  generationDone: z.boolean(),
  checkpoint: z.object({ version: z.number().int().nonnegative(), data: jsonObject }).optional(),
  outputs: z.array(z.object({ assetId: id<AssetId>(), output, filename: z.string(), file: file.optional(),
    delivery: z.enum(['pending', 'published', 'projected', 'suppressed', 'failed']), issues: z.array(issue) })),
  issues: z.array(issue), cancellation: cancellation.optional(),
})
export type JobRecord = z.infer<typeof jobRecord>
export const creationDomain = defineDomain({ name: 'convax_creation', version: 1, tables: {
  connections: domainTable<ConnectionId, ConnectionRecord>(connectionRecord),
  jobs: domainTable<JobId, JobRecord>(jobRecord),
} })
