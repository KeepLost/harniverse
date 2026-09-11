/**
 * Schedules management plugin, browser half: a sidebar footer trigger that
 * occupies the center column with the global management view (every stored
 * schedule, create/edit drawer, pause/resume/delete), plus the per-session
 * header action listing this session's schedules. Data arrives through the
 * generated scheduler Remote (`ctx.remote.scheduler`) — session-owned verbs
 * for the header entry, the global host-authority verbs for the management
 * view — so this plugin owns no business store, only the shared viewing
 * fact (center-view occupancy) that ties the trigger's pressed affordance
 * to actual occupancy.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: loads the scheduler namespace merge onto TypertClientRemote.
import type {} from '@deepseek-ai/dsh-scheduler/remote'
// Type-only: pulls the ui-conversation SlotMap merge (the header action list).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-layout SlotMap merge (the center view list).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-sidebar SlotMap merge (the footer action list).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ScheduleCenterView } from './ScheduleCenterView.tsx'
import { ScheduleSidebarAction } from './ScheduleSidebarAction.tsx'
import { ScheduleListAction } from './ScheduleListAction.tsx'
import { createScheduleViewStore } from './stores.ts'
import { en, NS, zh, type ScheduleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Schedule management copy. */
    'schedule': ScheduleKey
  }
}

export type {
  ScheduleListActionProps,
  ScheduleListActions,
  ScheduleStatusPatch,
} from './ScheduleListAction.tsx'
export type { ScheduleCenterActions, ScheduleCenterViewProps } from './ScheduleCenterView.tsx'
export type { ScheduleSidebarActionProps, ScheduleSidebarFace } from './ScheduleSidebarAction.tsx'

/** Required services for locale registration, the two slots, the layout exit, and the scheduler Remote. */
export const inject = ['sessions', 'slots', 'locale', 'remote', 'remote.scheduler', 'layout']

/**
 * Client plugin body: register the dictionaries, the header action, the
 * sidebar footer trigger, and the center management view.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-scheduler: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'schedule-list',
      // Before the job catalog: durable prompts outrank process work in scan order.
      order: 10,
      locale: NS,
      inject: sessionId => ({
        onRefresh: () => ctx.remote.scheduler.list(sessionId),
        onUpdate: (id, patch) => ctx.remote.scheduler.update(sessionId, id, patch),
        onRemove: id => ctx.remote.scheduler.delete(sessionId, id),
      }),
    }, ScheduleListAction),
  )
  // One store instance shared by the trigger and the view: the view writes
  // occupancy on mount/unmount, the trigger reads it.
  const viewStore = createScheduleViewStore()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'schedule-view',
    // After the Cordis panel: reading durable prompts follows process state.
    order: 10,
    locale: NS,
    store: viewStore,
    inject: () => ({
      openView: () => { ctx.layout.setCenterView('schedules') },
    }),
  }, ScheduleSidebarAction))
  ctx.slots.inject('center.view', () => ctx.slots.register({
    name: 'center.view',
    id: 'schedules',
    locale: NS,
    store: viewStore,
    inject: () => ({
      listAll: () => ctx.remote.scheduler.listAll(),
      runsOf: id => ctx.remote.scheduler.runsOf(id),
      create: (sessionId, input) => ctx.remote.scheduler.create(sessionId, input),
      update: (id, patch) => ctx.remote.scheduler.updateAny(id, patch),
      remove: id => ctx.remote.scheduler.deleteAny(id),
      closeView: () => { ctx.layout.clearCenterView() },
    }),
  }, ScheduleCenterView))
}
