/**
 * Browser statistics plugin contributing one entry to the conversation view
 * slot without defining a service.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh } from './locales.ts'
import { registerStatsConversation } from './stats-snapshot-builder.ts'
import { StatsView, type StatsViewInjected } from './StatsView.tsx'

/** Required services: the conversation slot, registries, ordinary Session paging, and the locale service. */
export const inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale']

/**
 * Client plugin body: register the stats view tab. The registration
 * rides the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-stats: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  registerStatsConversation(ctx)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'stats',
    order: 11,
    locale: NS,
    label: () => t('view.label'),
    inject: (sessionId: SessionId): StatsViewInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) {
        throw new Error(`ui-stats: session "${sessionId}" is unavailable`)
      }
      return {
        loadOlder: async () => {
          const before = binding.session.getSnapshot().views.get('stats')
          await binding.session.loadOlder()
          return binding.session.getSnapshot().views.get('stats') !== before
        },
      }
    },
  }, StatsView))
}
