/**
 * Schedules management plugin, browser half: the dashboard 定时任务 tab and
 * the session-header schedule list. The tab covers every stored schedule
 * (create/edit drawer, pause/resume, delete) over the global Remote surface;
 * the header list covers one session's schedules over the session-owned
 * verbs.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: loads the scheduler namespace merge onto TypertClientRemote.
import type {} from '@deepseek-ai/dsh-scheduler/remote'
// Type-only: pulls the ui-conversation SlotMap merge (the header action list).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-dashboard SlotMap merge (the dashboard tab list).
import type {} from '@deepseek-ai/dsh-client-ui-dashboard/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ScheduleTab } from './ScheduleTab.tsx'
import { ScheduleListAction } from './ScheduleListAction.tsx'
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
export type { ScheduleTabActions, ScheduleTabProps } from './ScheduleTab.tsx'

export const inject = ['sessions', 'slots', 'locale', 'remote', 'remote.scheduler']

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
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('dashboard.center.tab', () => ctx.slots.register({
    name: 'dashboard.center.tab',
    id: 'schedules',
    order: 10,
    locale: NS,
    label: () => t('view.nav'),
    inject: () => ({
      listAll: () => ctx.remote.scheduler.listAll(),
      runsOf: id => ctx.remote.scheduler.runsOf(id),
      create: (sessionId, input) => ctx.remote.scheduler.create(sessionId, input),
      update: (id, patch) => ctx.remote.scheduler.updateAny(id, patch),
      remove: id => ctx.remote.scheduler.deleteAny(id),
    }),
  }, ScheduleTab))
}
