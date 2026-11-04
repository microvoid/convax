/** Effect-owned Host node definitions, independent of client renderers. */
import type { CanvasData, CanvasNode, CanvasNodeTypeId, CanvasNodeTypeInfo, CanvasResource } from './types.ts'

/** One pure, adjacent payload upgrade; external side effects are forbidden. */
export interface CanvasNodeMigration {
  /** Stored source version; the result has version `fromVersion + 1`. */
  fromVersion: number
  /**
   * Transform an isolated payload without mutating external state.
   * @param data - Detached serialized fields from the preceding version.
   * @param signal - Aborted when the provider or Host is removed.
   * @returns The next version's serialized fields; rejected results are never committed.
   */
  migrate(data: CanvasData, signal: AbortSignal): CanvasData | Promise<CanvasData>
}

/** Host definition supplied by a node provider. */
export interface CanvasNodeDefinition extends CanvasNodeTypeInfo {
  /**
   * Validate serialized data and return the provider's normalized fields.
   * @param data - Detached payload in the provider's current data version.
   * @returns Valid serialized fields; rejection preserves the stored payload.
   */
  parse(data: CanvasData): CanvasData
  /** Adjacent pure transforms indexed by their stored source version. */
  migrations?: readonly CanvasNodeMigration[]
  /**
   * Resolve a resource for an explicit connection-to-composer action without granting writable roots.
   * @param node - Detached, current-version node snapshot.
   * @param signal - Cancelled with the reference request or provider removal.
   * @returns A reference validated by prepareReference through the composed filesystem; no prompt is sent.
   */
  prepareInput?(node: CanvasNode, signal: AbortSignal): CanvasResource | Promise<CanvasResource>
}

interface Registration {
  definition: CanvasNodeDefinition
  lifetime: AbortController
  pending: Set<Promise<unknown>>
}

/** Runtime registry; removal never deletes durable node records. */
export class CanvasNodeRegistry {
  private readonly definitions = new Map<CanvasNodeTypeId, Registration>()
  private readonly listeners = new Set<() => void>()
  private readonly revisions = new Map<CanvasNodeTypeId, number>()

  /**
   * @param reportObserverFailure - Reports notification failures without rejecting a completed registration.
   */
  constructor(private readonly reportObserverFailure: (error: unknown) => void) {}

  /**
   * Register one type until its owning effect is disposed.
   * @param definition - Unique provider-qualified type.
   * @returns Idempotent removal function.
   */
  register(definition: CanvasNodeDefinition): () => Promise<void> {
    if (this.definitions.has(definition.id)) throw new Error(`Node type '${definition.id}' is already registered`)
    if (!Number.isInteger(definition.dataVersion) || definition.dataVersion < 0) throw new Error('Node data version must be a nonnegative integer')
    const versions = new Set<number>()
    for (const step of definition.migrations ?? []) {
      if (!Number.isInteger(step.fromVersion) || step.fromVersion < 0
        || step.fromVersion >= definition.dataVersion || versions.has(step.fromVersion)) {
        throw new Error(`Node type '${definition.id}' has an invalid or duplicate migration source version`)
      }
      versions.add(step.fromVersion)
    }
    const registered = { ...definition, ports: structuredClone(definition.ports),
      ...(definition.dataSchema === undefined ? {} : { dataSchema: structuredClone(definition.dataSchema) }),
      ...(definition.capabilities === undefined ? {} : { capabilities: structuredClone(definition.capabilities) }),
      ...definition.migrations === undefined ? {} : { migrations: definition.migrations.map(step => ({ ...step })) } }
    for (const port of registered.ports) Object.freeze(port)
    Object.freeze(registered.ports)
    if (registered.capabilities !== undefined) Object.freeze(registered.capabilities)
    for (const step of registered.migrations ?? []) Object.freeze(step)
    if (registered.migrations !== undefined) Object.freeze(registered.migrations)
    Object.freeze(registered)
    const registration: Registration = { definition: registered, lifetime: new AbortController(), pending: new Set() }
    this.definitions.set(registered.id, registration)
    this.revisions.set(registered.id, this.revisionOf(registered.id) + 1)
    this.notify()
    let closing: Promise<void> | undefined
    return () => {
      if (closing !== undefined) return closing
      if (this.definitions.get(registered.id) === registration) {
        registration.lifetime.abort(new Error(`Node provider '${registered.id}' was removed`))
        this.definitions.delete(registered.id)
        this.revisions.set(registered.id, this.revisionOf(registered.id) + 1)
        this.notify()
      }
      closing = Promise.allSettled([...registration.pending]).then(() => {})
      return closing
    }
  }

  /**
   * Resolve the currently available Host provider.
   * @param id - Provider-qualified type identity.
   * @returns Definition or undefined when its provider is absent.
   */
  get(id: CanvasNodeTypeId): CanvasNodeDefinition | undefined { return this.definitions.get(id)?.definition }

  /**
   * Identify registration changes while an input attempt is pending.
   * @param id - Provider-qualified identity.
   * @returns Monotonic process-local revision, including removals.
   */
  revisionOf(id: CanvasNodeTypeId): number { return this.revisions.get(id) ?? 0 }

  /**
   * Run cancellable provider work and drain it when the registration is removed.
   * @param definition - Exact definition returned by `get`; a replacement cannot inherit its work.
   * @param signal - Consumer lifetime.
   * @param run - Work that observes the combined cancellation signal.
   * @returns The result only while the same provider remains active.
   */
  use<T>(definition: CanvasNodeDefinition, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const registration = this.definitions.get(definition.id)
    if (registration?.definition !== definition) return Promise.reject(new Error('Node provider changed'))
    const combined = AbortSignal.any([signal, registration.lifetime.signal])
    const pending = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return run(combined)
    }).then((value) => {
      combined.throwIfAborted()
      return value
    })
    registration.pending.add(pending)
    void pending.then(() => { registration.pending.delete(pending) }, () => { registration.pending.delete(pending) })
    return pending
  }

  /**
   * List the available provider metadata without exposing callbacks.
   * @returns Client-safe metadata without provider callbacks.
   */
  list(): CanvasNodeTypeInfo[] {
    return [...this.definitions.values()].map(({ definition: { id, dataVersion, ports, description, dataSchema, capabilities } }) => ({
      id, dataVersion, ports: structuredClone(ports),
      ...(description === undefined ? {} : { description }),
      ...(dataSchema === undefined ? {} : { dataSchema: structuredClone(dataSchema) }),
      ...(capabilities === undefined ? {} : { capabilities: structuredClone(capabilities) }),
    }))
  }

  /**
   * Observe provider registration and removal independently of graph writes.
   * @param listener - Metadata invalidation callback.
   * @returns Idempotent subscription disposer.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener() } catch (error) { this.reportObserverFailure(error) }
    }
  }
}
