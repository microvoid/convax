/** Creation's persistent records; all updates pass through the domain writer. */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { creationDomain, jobRecord } from './schema.ts'
import type { JobRecord } from './schema.ts'
import type { JobId } from './types.ts'

export class CreationStore {
  readonly connections
  readonly jobs
  constructor(private readonly domain: Domain<typeof creationDomain>) {
    this.connections = domain.table('connections')
    this.jobs = domain.table('jobs')
  }
  get(id: JobId): JobRecord {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error('Creation task was not found')
    return job
  }
  update(id: JobId, update: (job: JobRecord) => JobRecord): Promise<JobRecord> {
    return this.jobs.update(id, current => jobRecord.parse(update(current)))
  }
  close(): Promise<void> { return this.domain.close() }
}
