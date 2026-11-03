/** Public presentation hosts for the shared task manager and Session reminder action. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleCatalogActionInjected } from './ScheduleCatalogAction.tsx'
import type { TaskManagerInjected } from './TaskManagerPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    /** Manage retained Host tasks while the containing surface owns navigation. */
    'schedule.manager': {
      scope: 'root'
      props: {
        /** Open the containing surface's native conversation editor for task creation. */
        readonly onNewTask: () => void
        /** Navigate to the task's available, unarchived original Session. */
        readonly onOpenSession: (id: SessionId) => void
        /** Use compact insets without native titlebar clearance inside another surface. */
        readonly presentation?: 'embedded'
        /** Optional containing surface dismissal beside the native creation action. */
        readonly close?: { readonly label: string; readonly onClose: () => void }
      }
      locale: 'schedule.manager'
      inject: Omit<TaskManagerInjected, 'onNewTask' | 'onOpenSession'>
    }
    /** Open the retained Session's active reminders in its native tool pane. */
    'schedule.session': {
      scope: 'session'
      locale: 'schedule.catalog'
      inject: ScheduleCatalogActionInjected
    }
  }
}
