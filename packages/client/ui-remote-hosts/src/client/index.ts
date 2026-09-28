import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-remote-hosts/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { RemoteHostsSidebarAction } from './RemoteHostsSidebarAction.tsx'
import { RemoteHostsView } from './RemoteHostsView.tsx'
import { createRemoteHostsViewStore } from './stores.ts'
import { en, NS, zh, type RemoteHostsKey } from './locales.ts'
import type { AuthSecrets, ProbeHostInput, RemoteHostId, UpsertHostInput } from '@deepseek-ai/dsh-remote-hosts/types'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { remoteHosts: RemoteHostsKey } }

export const inject = ['slots', 'locale', 'remote', 'remote.remoteHosts', 'layout']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'ui-remote-hosts: dictionaries')
  const store = createRemoteHostsViewStore()
  const openView = (): void => { ctx.layout.setCenterView('remote-hosts') }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'remote-hosts', order: 20, locale: NS, store, inject: () => ({ openView }) }, RemoteHostsSidebarAction))
  ctx.slots.inject('center.view', () => ctx.slots.register({ name: 'center.view', id: 'remote-hosts', locale: NS, store, inject: () => ({ list: () => ctx.remote.remoteHosts.list(), upsert: (input: UpsertHostInput) => ctx.remote.remoteHosts.upsert(input), probe: (input: ProbeHostInput) => ctx.remote.remoteHosts.probe(input), connect: (id: RemoteHostId, secrets?: AuthSecrets) => ctx.remote.remoteHosts.connect({ id, ...(secrets === undefined ? {} : { secrets, storeCredentials: false }) }), openRemote: (id: RemoteHostId) => { const browser = (globalThis as { location?: Location; open?: typeof window.open }).open; const location = (globalThis as { location?: Location }).location; if (browser === undefined || location === undefined) return; const url = new URL(location.href); url.searchParams.set('dshRemoteHost', id); browser(url, '_blank', 'noopener,noreferrer') }, disconnect: (id: RemoteHostId) => ctx.remote.remoteHosts.disconnect(id), remove: (id: RemoteHostId) => ctx.remote.remoteHosts.removeHost(id), closeView: () => { ctx.layout.clearCenterView() } }) }, RemoteHostsView))
}
