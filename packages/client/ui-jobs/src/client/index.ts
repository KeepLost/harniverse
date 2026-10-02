/**
 * Background-job plugin, browser half: contributes one session-header action
 * that renders this session's `ctx.jobs` records. The list state arrives
 * through the `jobsBySession` frame mirror; the expanded row's output viewer
 * and the two-step human stop write through the shared connection api client
 * (`jobs.follow` / `jobs.kill`), so the plugin holds no state of its own
 * beyond popover and row-viewport state.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { JobListAction } from './JobListAction.tsx'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type JobKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Background-job list copy. */
    'job': JobKey
  }
}

export type { JobListActionProps } from './JobListAction.tsx'

/** Required services for locale registration, the header slot, and the wire face. */
export const inject = ['sessions', 'slots', 'locale', 'connection']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-job: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'job-list',
      // After the subagent catalog: session lineage reads before process work.
      order: 20,
      locale: NS,
      inject: () => ({ api: connection.api }),
    }, JobListAction),
  )
}
