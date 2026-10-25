/**
 * Network proxy settings plugin, browser half: contributes the Settings →
 * 网络代理 section (`settings.section`) over the host `network-proxy`
 * settings namespace. The section only edits the durable fields; the host
 * plugin resolves each committed change into a live route through
 * `setProxyOverride`, so saving never restarts anything.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-settings SlotMap merge (the settings.section entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { NetworkProxySection } from './NetworkProxySection.tsx'
import { decodeNetworkProxySection, NETWORK_PROXY_NS } from './decode.ts'
import { en, NS, zh, type NetworkProxyLocaleKey } from './locales.ts'

export type { NetworkProxyLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Network proxy section copy. */
    'settings.network-proxy': NetworkProxyLocaleKey
  }
}

/** Required services: the seat's slot registry, the settings transport, and copy. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Client plugin body: register the dictionaries and the Network proxy
 * settings section bound to the host `network-proxy` namespace.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-network-proxy: dictionaries')

  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind({ namespace: NETWORK_PROXY_NS, decode: decodeNetworkProxySection })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'network-proxy',
    // After Global rules (12) and before Plugins (15): the route steers every
    // outbound connection, so it reads with the connection-level settings.
    order: 13,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      hooks: { scope },
      set: (field: string, value: unknown) => scope.set(field, value),
      unset: (field: string) => scope.unset(field),
    }),
  }, NetworkProxySection))
}
