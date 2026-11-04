/** Provider-owned pure transforms with revision-checked durable payload copies. */
import { isDeepStrictEqual } from 'node:util'
import type { CanvasRepository } from './repository.ts'
import type { CanvasNodeDefinition } from './registry.ts'
import type { CanvasId, CanvasNode, CanvasNodeId, CanvasNodeIssue } from './types.ts'

interface Attempt {
  definition: CanvasNodeDefinition
  node: CanvasNode
  issue?: CanvasNodeIssue
}

/** One Host owns upgrade work; views and client renderer availability are irrelevant. */
export class CanvasMigrationCoordinator {
  private readonly lifetime = new AbortController()
  private readonly attempts = new Map<CanvasNodeId, Attempt>()
  private unsubscribe: (() => void) | undefined
  private pending: Promise<void> | undefined
  private dirty = false

  /**
   * @param repository - Exclusive graph owner with active provider definitions.
   * @param reportFailure - Reports storage failures that prevent a safe commit.
   */
  constructor(private readonly repository: CanvasRepository, private readonly reportFailure: (error: unknown) => void) {}

  /**
   * Observe graph and provider changes and inspect all existing nodes.
   * @returns After initial inspection and applicable upgrades settle.
   */
  async start(): Promise<void> {
    this.unsubscribe = this.repository.subscribe(() => { void this.schedule() })
    await this.retry()
  }

  /**
   * Recheck failed nodes against their current provider and original durable data.
   * @returns After pending inspections settle; failures remain visible per node.
   */
  async retry(): Promise<void> {
    this.attempts.clear()
    await this.schedule()
  }

  /**
   * Stop new inspections and drain provider work before repository teardown.
   * @returns When cancelled transforms can no longer commit or publish diagnostics.
   */
  async close(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.lifetime.abort()
    await this.pending
  }

  private schedule(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.dirty = true
    if (this.pending !== undefined) return this.pending
    const pending = Promise.resolve().then(async () => {
      try {
        while (this.dirty && !this.lifetime.signal.aborted) {
          this.dirty = false
          await this.inspect()
        }
      } finally {
        // Release the pump before its promise settles so a retry cannot join completed work.
        this.pending = undefined
      }
    })
    this.pending = pending
    void pending.catch((error: unknown) => { this.reportFailure(error) })
    return pending
  }

  private publish(): void {
    if (this.lifetime.signal.aborted) return
    this.repository.setNodeIssues([...this.attempts.values()].flatMap(attempt => attempt.issue === undefined ? [] : [attempt.issue]))
  }

  private isClosed(): boolean { return this.lifetime.signal.aborted }

  private async inspect(): Promise<void> {
    const graph = this.repository.snapshot()
    const retained = new Set(graph.canvases.flatMap(canvas => canvas.nodes.map(node => node.id)))
    for (const id of this.attempts.keys()) if (!retained.has(id)) this.attempts.delete(id)
    for (const canvas of graph.canvases) {
      for (const node of canvas.nodes) {
        if (this.lifetime.signal.aborted) return
        const definition = this.repository.nodeTypes.get(node.typeId)
        if (definition === undefined) { this.attempts.delete(node.id); continue }
        const previous = this.attempts.get(node.id)
        if (previous?.definition === definition && isDeepStrictEqual(previous.node, node)) continue
        const attempt: Attempt = { definition, node }
        this.attempts.set(node.id, attempt)
        try {
          if (node.dataVersion === definition.dataVersion) {
            definition.parse(structuredClone(node.data))
          } else {
            attempt.issue = { canvasId: canvas.id, nodeId: node.id, kind: 'migrating', message: 'Upgrading node data' }
            this.publish()
            await this.upgrade(canvas.id, node, definition)
          }
        } catch (error) {
          if (this.isClosed()) return
          const current = this.repository.snapshot().canvases.find(value => value.id === canvas.id)
            ?.nodes.find(value => value.id === node.id)
          if (this.repository.nodeTypes.get(node.typeId) !== definition || !isDeepStrictEqual(current, node)) {
            this.attempts.delete(node.id)
            this.dirty = true
            continue
          }
          attempt.issue = { canvasId: canvas.id, nodeId: node.id, kind: 'incompatible',
            message: `Node data is incompatible: ${error instanceof Error ? error.message : String(error)}. Update the provider or retry after repairing it.` }
        }
        if (attempt.issue?.kind === 'migrating') delete attempt.issue
      }
    }
    this.publish()
  }

  private upgrade(canvasId: CanvasId, node: CanvasNode, definition: CanvasNodeDefinition): Promise<void> {
    return this.repository.nodeTypes.use(definition, this.lifetime.signal, async (signal) => {
      let data = structuredClone(node.data)
      if (node.dataVersion > definition.dataVersion) throw new Error(`Stored version ${node.dataVersion} is newer than provider version ${definition.dataVersion}`)
      for (let version = node.dataVersion; version < definition.dataVersion; version++) {
        signal.throwIfAborted()
        const migration = definition.migrations?.find(value => value.fromVersion === version)
        if (migration === undefined) throw new Error(`Missing migration from version ${version} to ${version + 1}`)
        data = await migration.migrate(structuredClone(data), signal)
      }
      signal.throwIfAborted()
      data = definition.parse(structuredClone(data))
      const committed = await this.repository.commitMigration(canvasId, node, definition, data, signal)
      if (!committed) this.dirty = true
    })
  }
}
