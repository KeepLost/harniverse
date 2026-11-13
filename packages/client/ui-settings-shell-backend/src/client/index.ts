/**
 * Shell backend settings plugin, browser half: contributes the Settings →
 * Shell 后端 section (`settings.section`) over the host `shell-backend`
 * settings namespace. The section edits the durable `backend` field only;
 * the namespace declares `applies: 'restart'`, so the app boot bridge
 * resolves the stored preference into `$DSH_SHELL_BACKEND` and the shell
 * tool rows re-compose on the next start.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-settings SlotMap merge (the settings.section entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ShellBackendSection } from './ShellBackendSection.tsx'
import { decodeShellBackendSection, SHELL_BACKEND_NS } from './decode.ts'
import { en, NS, zh, type ShellBackendLocaleKey } from './locales.ts'

export type { ShellBackendLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shell backend section copy. */
    'settings.shell-backend': ShellBackendLocaleKey
  }
}

/** Required services: the seat's slot registry, the settings transport, and copy. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Client plugin body: register the dictionaries and the Shell backend
 * settings section bound to the host `shell-backend` namespace.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-shell-backend: dictionaries')

  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind({ namespace: SHELL_BACKEND_NS, decode: decodeShellBackendSection })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'shell-backend',
    // After Network proxy (13) and before Plugins (15): the preference
    // decides which shell tool rows the host composes, so it reads with the
    // composition-level settings.
    order: 14,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      hooks: { scope },
      set: (field: string, value: unknown) => scope.set(field, value),
    }),
  }, ShellBackendSection))
}
