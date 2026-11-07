/** Composer default-save feedback shared across Session bindings. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { writeDefaultPreset } from './settings-store.ts'

/** A default save outlives the composer that created its receiving Session. */
export interface AgentPresetDefaultState {
  saving: boolean
  error: string | null
}

/** Owns mode changes and saved-default feedback for every embedded composer in one client plugin. */
export class AgentPresetDefaultController {
  /** Save progress and failures shared by all embedded composers. */
  readonly store: SnapshotStore<AgentPresetDefaultState> = createSnapshotStore({ saving: false, error: null })

  constructor(private readonly ctx: ClientContext) {}

  /**
   * Admit one choice through its selection or creation and accepted-default write.
   * @param operation - Composer action and its guarded save capability.
   * @returns The action result, or undefined when another choice is still pending. Rejections propagate after releasing ownership.
   */
  async change<T>(operation: (save: (id: string) => Promise<void>) => Promise<T>): Promise<T | undefined> {
    if (this.store.getSnapshot().saving) return undefined
    this.store.set({ saving: true, error: null })
    try {
      return await operation(id => this.persist(id))
    } finally {
      this.store.update((state) => { state.saving = false })
    }
  }

  /**
   * Save an accepted mode; failure remains visible in the current composer.
   * @param id - Accepted preset to use for future Sessions.
   * @returns Once the write settles, or immediately while another choice owns the default.
   */
  async save(id: string): Promise<void> {
    await this.change(save => save(id))
  }

  private async persist(id: string): Promise<void> {
    try {
      const error = await writeDefaultPreset(this.ctx, id)
      if (error !== undefined) this.store.update((state) => { state.error = error })
    } catch (error) {
      this.store.update((state) => { state.error = error instanceof Error ? error.message : String(error) })
    }
  }
}
