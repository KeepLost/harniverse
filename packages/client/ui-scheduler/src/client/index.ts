/**
 * Schedule list plugin, browser half: contributes one session-header action
 * listing this session's durable schedules with pause/resume/delete verbs.
 * The data arrives through the generated scheduler Remote (`ctx.remote.scheduler`),
 * so this plugin owns no store; each popover open and each mutation re-reads
 * the authoritative storage-domain table.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: loads the scheduler namespace merge onto TypertClientRemote.
import type {} from '@deepseek-ai/dsh-scheduler/remote'
// Type-only: pulls the ui-conversation SlotMap merge (the header action list).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ScheduleListAction } from './ScheduleListAction.tsx'
import { en, NS, zh, type ScheduleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Schedule list copy. */
    'schedule': ScheduleKey
  }
}

export type {
  ScheduleListActionProps,
  ScheduleListActions,
  ScheduleStatusPatch,
} from './ScheduleListAction.tsx'

/** Required services for locale registration, the header slot, and the scheduler Remote. */
export const inject = ['sessions', 'slots', 'locale', 'remote', 'remote.scheduler']

/**
 * Client plugin body: register the dictionaries and the header action.
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
        onRemove: id => ctx.remote.scheduler.remove(sessionId, id),
      }),
    }, ScheduleListAction),
  )
}
