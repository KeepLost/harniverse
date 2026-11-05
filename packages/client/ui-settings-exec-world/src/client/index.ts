/**
 * Execution world settings plugin, browser half: contributes the Settings →
 * 执行世界 section (`settings.section`) over the host `exec-world` settings
 * namespace. The section edits the durable `world` field only; the namespace
 * declares `applies: 'restart'`, so the app boot bridge resolves the stored
 * preference (plus the VM provider probe) into `$DSH_EXEC_WORLD` and the
 * capability-family rows re-compose on the next start.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-settings SlotMap merge (the settings.section entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ExecWorldSection } from './ExecWorldSection.tsx'
import { decodeExecWorldSection, EXEC_WORLD_NS } from './decode.ts'
import { en, NS, zh, type ExecWorldLocaleKey } from './locales.ts'

export type { ExecWorldLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Execution world section copy. */
    'settings.exec-world': ExecWorldLocaleKey
  }
}

/** Required services: the seat's slot registry, the settings transport, and copy. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Client plugin body: register the dictionaries and the execution world
 * settings section bound to the host `exec-world` namespace.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-exec-world: dictionaries')

  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind({ namespace: EXEC_WORLD_NS, decode: decodeExecWorldSection })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'exec-world',
    // The composition-level group (network proxy 13, shell backend 14,
    // plugins 15, governor 16) is full, so the world picker takes the next
    // slot ahead of the per-agent sections (20+): it swaps capability
    // families exactly like its neighbors swap the shell stack.
    order: 17,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      hooks: { scope },
      set: (field: string, value: unknown) => scope.set(field, value),
    }),
  }, ExecWorldSection))
}
