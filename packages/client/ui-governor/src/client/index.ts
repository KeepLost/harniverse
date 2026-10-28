/**
 * Resource governor board, browser half: the dashboard 本机资源 tab and the
 * Resource-governance settings section. The tab renders the
 * sessions-as-processes overview (per-session CPU, memory against effective
 * limits, live command counts, breach badges, and per-session memory quota
 * adjustment); data arrives through the generated governor Remote
 * (`ctx.remote.governor`) polled at the sampling cadence — the same door
 * scripts use, so the page cannot drift from the HTTP API — while quota
 * writes ride the client settings scope into the `governor:` settings
 * section.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: loads the governor namespace merge onto TypertClientRemote.
import type {} from '@deepseek-ai/dsh-governor/remote'
// Type-only: pulls the ui-dashboard SlotMap merge (the dashboard tab list).
import type {} from '@deepseek-ai/dsh-client-ui-dashboard/client'
// Type-only: pulls the ui-settings SlotMap merge (the settings.section list)
// and the ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GovernorResourcesTab } from './GovernorResourcesTab.tsx'
import { GovernorSettingsSection } from './GovernorSettingsSection.tsx'
import type { GovernorQuotaSettings } from './GovernorSettingsSection.tsx'
import { en, NS, zh, type GovernorKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Governor board copy. */
    'governor': GovernorKey
  }
}

export type {
  GovernorConfigRuntime, GovernorQuotaSettings, GovernorSettingsInjected, GovernorSettingsSectionProps,
} from './GovernorSettingsSection.tsx'

/**
 * Settings namespace of the governor's `governor:` section. Spelled here
 * rather than imported: a client package must not depend on a Host package's
 * runtime values, and the Host service owns the same spelling.
 */
const GOVERNOR_SETTINGS_NS = 'governor'

/** Required services for locale registration, the slots, the governor Remote, and the settings scope. */
export const inject = ['slots', 'locale', 'remote', 'remote.governor', 'settingsScope']

/** Poll cadence matching the governor's base sampling interval. */
const POLL_MS = 5_000

/**
 * Client plugin body: register the dictionaries, the dashboard resources
 * tab, and the global-quota settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-governor: dictionaries')
  const t = ctx.locale.bind(NS)
  // The dashboard 本机资源 tab: the metering surface this package owns.
  ctx.slots.inject('dashboard.center.tab', () => ctx.slots.register({
    name: 'dashboard.center.tab',
    id: 'resources',
    order: 30,
    locale: NS,
    label: () => t('tab.resources'),
    inject: () => ({
      overview: () => ctx.remote.governor.overview(),
      adjustQuota: (sessionId: string, memoryBytes: number | null) =>
        ctx.remote.governor.sessionQuotaAdjust(sessionId, memoryBytes),
      pollMs: POLL_MS,
    }),
  }, GovernorResourcesTab))
  const quotaScope = ctx.settingsScope.bind<GovernorQuotaSettings>({ namespace: GOVERNOR_SETTINGS_NS })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'governor',
    // After the Plugins page: runtime governance follows host configuration.
    order: 16,
    label: () => t('settings.nav'),
    inject: () => ({
      hooks: { scope: quotaScope },
      setMemoryLimit: (limit: 'auto' | number) => quotaScope.set('memory', { limit }),
      configGet: () => ctx.remote.governor.configGet(),
      t,
    }),
  }, GovernorSettingsSection))
}
