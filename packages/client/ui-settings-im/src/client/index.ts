/**
 * IM bot settings plugin, browser half. Registers the "IM 机器人" settings
 * section (`im`, ordered right after Agent presets): a channel column driven
 * by the host's platform descriptors and, per channel, the connect form, the
 * bot cards, and the paired-accounts block. Data and verbs ride the typed
 * `chatBots` Remote (`ctx.remote.chatBots`) over the shared `/api` channel;
 * the model, agent preset, and workspace choices come from the connection's
 * catalog wire and the workspaces service. Export discipline:
 * packages/client/AGENTS.md.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-settings SlotMap merge (the settings.section list).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createImController, type ChatBotsRemote } from './controller.ts'
import { ImSection } from './ImSection.tsx'
import { en, NS, zh, type ImKey } from './locales.ts'
import { createImStore } from './stores.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** IM bot settings copy. */
    'settings.im': ImKey
  }
}

export type { ImSectionProps } from './ImSection.tsx'
export type { ImInjected } from './controller.ts'
export type { ImState } from './stores.ts'

/**
 * Required services: the slot registry, the locale seat, the connection (the
 * catalog wire), the Remote mount and its `chatBots` namespace (a host
 * without the chat manager never activates this plugin), and the workspaces
 * service.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.chatBots', 'workspaces']

/**
 * The single binding point to the Host Remote: the mounted `chatBots`
 * namespace service, resolved by name.
 * @param ctx - client root context.
 * @returns the namespace face.
 */
function chatBotsRemote(ctx: ClientContext): ChatBotsRemote {
  return ctx.get('remote.chatBots') as ChatBotsRemote
}

/**
 * Client plugin body: register the dictionaries and the settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-im: dictionaries')
  const remote = chatBotsRemote(ctx)
  const { api } = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)
  const pickDirectory = typeof ctx.workspaces.pickDirectory === 'function'
    ? () => ctx.workspaces.pickDirectory()
    : undefined
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'im',
    // After Agent presets (20) and before Voice (25): bot behavior follows agent composition.
    order: 21,
    label: () => t('nav'),
    locale: NS,
    store: createImStore(),
    inject: actions => createImController({
      remote,
      api,
      ...pickDirectory === undefined ? {} : { pickDirectory },
    }, actions),
  }, ImSection))
}
