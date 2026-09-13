/**
 * Governor board, browser half: a sidebar footer trigger that occupies the
 * center column with the sessions-as-processes overview (per-session CPU,
 * memory against effective limits, live command counts, breach badges, and
 * per-session memory quota adjustment). Data arrives through the generated
 * governor Remote (`ctx.remote.governor`) polled at the sampling cadence —
 * the same door scripts use, so the page cannot drift from the HTTP API.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: loads the governor namespace merge onto TypertClientRemote.
import type {} from '@deepseek-ai/dsh-governor/remote'
// Type-only: pulls the ui-layout SlotMap merge (the center view list).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-sidebar SlotMap merge (the footer action list).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GovernorCenterView } from './GovernorCenterView.tsx'
import { GovernorSidebarAction } from './GovernorSidebarAction.tsx'
import { createGovernorViewStore } from './stores.ts'
import { en, NS, zh, type GovernorKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Governor board copy. */
    'governor': GovernorKey
  }
}

export type { GovernorSidebarActionProps, GovernorSidebarFace } from './GovernorSidebarAction.tsx'
export type { GovernorCenterActions, GovernorCenterViewProps } from './GovernorCenterView.tsx'

/** Required services for locale registration, the two slots, the layout exit, and the governor Remote. */
export const inject = ['slots', 'locale', 'remote', 'remote.governor', 'layout']

/** Poll cadence matching the governor's base sampling interval. */
const POLL_MS = 5_000

/**
 * Client plugin body: register the dictionaries, the sidebar footer trigger,
 * and the center board view.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-governor: dictionaries')
  // One store instance shared by the trigger and the view: the view writes
  // occupancy on mount/unmount, the trigger reads it.
  const viewStore = createGovernorViewStore()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'governor-view',
    // After the schedules trigger: runtime telemetry follows durable prompts.
    order: 20,
    locale: NS,
    store: viewStore,
    inject: () => ({
      openView: () => { ctx.layout.setCenterView('governor') },
    }),
  }, GovernorSidebarAction))
  ctx.slots.inject('center.view', () => ctx.slots.register({
    name: 'center.view',
    id: 'governor',
    locale: NS,
    store: viewStore,
    inject: () => ({
      overview: () => ctx.remote.governor.overview(),
      adjustQuota: (sessionId, memoryBytes) => ctx.remote.governor.sessionQuotaAdjust(sessionId, memoryBytes),
      closeView: () => { ctx.layout.clearCenterView() },
      pollMs: POLL_MS,
    }),
  }, GovernorCenterView))
}
