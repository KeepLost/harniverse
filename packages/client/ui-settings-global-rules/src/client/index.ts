/**
 * Global rules settings plugin, browser half: contributes the Settings →
 * 全局规则 section (`settings.section`) and its nav glyph over the
 * `globalRules` Remote. The edited file is the harness home's `AGENTS.md`
 * — the user-global instruction scope — so an edit reaches every session
 * through the built-in instruction loader with no propagation of its own.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-settings SlotMap merge (the settings.section entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { GlobalRulesSection } from './GlobalRulesSection.tsx'
import type { GlobalRulesSectionInjected } from './GlobalRulesSection.tsx'
import { NavIcon } from './NavIcon.tsx'
import { en, NS, zh, type GlobalRulesLocaleKey } from './locales.ts'

export type { GlobalRulesSectionInjected } from './GlobalRulesSection.tsx'
export type { GlobalRulesLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Global rules editor copy (the settings section). */
    'settings.global-rules': GlobalRulesLocaleKey
  }
}

/** Required services: the seat's slot registry, the wire face, and copy. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Client plugin body: register the dictionaries, the Global rules settings
 * section, and its nav glyph.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-global-rules: dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'global-rules',
    // After the model sections (10–11) and before Plugins (15): the rules
    // file steers every model turn, so it reads with the model family.
    order: 12,
    label: () => t('nav'),
    locale: NS,
    inject: (): GlobalRulesSectionInjected => ({ api: connection.api.globalRules }),
  }, GlobalRulesSection))
  ctx.slots.inject('settings.nav.icon', () => ctx.slots.register({
    name: 'settings.nav.icon',
    key: 'global-rules',
  }, NavIcon))
}
