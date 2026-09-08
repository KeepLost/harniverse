import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { StatusIcon } from './StatusIcon.tsx'
import { en, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { connectionStatus: keyof typeof en }
}

/** Rendering and observation dependencies; no authentication action is injected into the icon. */
export const inject = ['slots', 'connection', 'locale']

/** Occupy the sidebar-owned status seat through the declaration barrier. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register('connectionStatus', { en, zh }), 'ui-connection-status: dictionaries')
  ctx.slots.inject('sidebar.header.status', () => ctx.slots.register({
    name: 'sidebar.header.status',
    locale: 'connectionStatus',
    inject: () => ({ hooks: { health: connection.health } }),
  }, StatusIcon))
}
