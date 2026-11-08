/** Browser activity adapter; the Host owns notice eligibility, frequency and window arbitration. */
import type { ClientNoticeAction } from '@convax/api-contracts/notices'
import type { NoticeDisplayContext } from '@deepseek-ai/dsh-convax-plugin-host/types'
import type { DesktopUpdateBridge } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import type { NoticeEnvironment } from './runtime.ts'

/** Classifies a missing native update capability for localized user feedback. */
export class NoticeUpdateUnavailableError extends Error {}

/** Explicit dependencies of one window's interaction adapter. */
export interface BrowserNoticeOptions {
  document: Document
  window: Window
  running: () => boolean
  capabilities: () => string[]
  updates: DesktopUpdateBridge | undefined
  now?: () => number
}

/** Tracks activity without retaining state in module-level browser globals. */
export class BrowserNoticeEnvironment implements NoticeEnvironment {
  private lastActivity: number
  private pointerDown = false
  private idleMs = 0
  private readonly now: () => number

  /** @param options - Window lifetime, current tasks and the optional native update bridge. */
  constructor(private readonly options: BrowserNoticeOptions) {
    this.now = options.now ?? Date.now
    this.lastActivity = this.now()
  }

  /** Apply the Host deployment's idle interval. @param idleMs - Required quiet time before ordinary notices. */
  configure(idleMs: number): void { this.idleMs = idleMs }

  /** Read safe presentation timing without treating this feature's own dialog as a blocker. */
  context(): NoticeDisplayContext {
    const { document } = this.options
    const otherModal = [...document.querySelectorAll('[aria-modal="true"], [data-shortcut-modal]')]
      .some(element => !element.closest('[data-convax-notice]') && !element.querySelector('[data-convax-notice]'))
    const focused = document.activeElement
    const editable = focused?.closest('[contenteditable]')
    const editing = focused !== null && (focused.matches('input, textarea, select')
      || (editable !== null && editable !== undefined && editable.getAttribute('contenteditable') !== 'false'))
    return {
      available: document.visibilityState === 'visible' && document.hasFocus() && !otherModal,
      busy: this.pointerDown || editing || this.options.running() || this.now() - this.lastActivity < this.idleMs,
      capabilities: this.options.capabilities(),
    }
  }

  /** Observe input and visibility until the owning runtime leaves. @param wake - Recheck presentation timing. @returns Listener cleanup. */
  subscribe(wake: () => void): () => void {
    const activity = (): void => { this.lastActivity = this.now(); wake() }
    const down = (): void => { this.pointerDown = true; activity() }
    const up = (): void => { this.pointerDown = false; activity() }
    const visibility = (): void => { this.pointerDown = false; wake() }
    const { document, window } = this.options
    document.addEventListener('keydown', activity, true)
    document.addEventListener('input', activity, true)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('blur', visibility)
    window.addEventListener('focus', visibility)
    return () => {
      document.removeEventListener('keydown', activity, true)
      document.removeEventListener('input', activity, true)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('blur', visibility)
      window.removeEventListener('focus', visibility)
    }
  }

  /**
   * Open a user-selected destination; the native updater owns download and installation authorization.
   * @param action - Validated action supplied by the Host.
   */
  async execute(action: ClientNoticeAction): Promise<void> {
    switch (action.type) {
      case 'open_update': {
        if (this.options.updates === undefined) throw new NoticeUpdateUnavailableError('Desktop updates are unavailable')
        await this.options.updates.open()
        return
      }
      case 'open_url': this.options.window.open(action.url, '_blank', 'noopener,noreferrer'); return
      case 'dismiss':
      case 'snooze': return
    }
  }
}
