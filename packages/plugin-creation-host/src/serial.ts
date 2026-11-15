/** Async ordering only for operations which share a commit boundary. */
export class CreationSerial {
  private readonly tails = new Map<string, Promise<unknown>>()
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key)
    const pending = (previous ?? Promise.resolve()).then(operation, operation)
    this.tails.set(key, pending)
    try { return await pending } finally { if (this.tails.get(key) === pending) this.tails.delete(key) }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.tails.values()]) }
}
