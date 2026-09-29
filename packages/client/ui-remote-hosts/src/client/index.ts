/**
 * Browser half of the remote-host management surface: the sidebar footer
 * trigger plus the center view over the host-authority remote-hosts Remote.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-remote-hosts/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: carries the SlotMap merge declaring the key-directory flow hole.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contract.ts'
import { RemoteHostsSidebarAction } from './RemoteHostsSidebarAction.tsx'
import { RemoteHostsView } from './RemoteHostsView.tsx'
import { createRemoteHostsViewStore } from './stores.ts'
import { en, NS, zh, type RemoteHostsKey } from './locales.ts'
import type { AuthSecrets, RemoteHostId, UpsertHostInput, VerifyHostInput } from '@deepseek-ai/dsh-remote-hosts/types'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { remoteHosts: RemoteHostsKey } }

export type { KeyDirectoryFlowOwnerProps } from './contract.ts'

export const inject = ['slots', 'locale', 'remote', 'remote.remoteHosts', 'layout']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'ui-remote-hosts: dictionaries')
  const store = createRemoteHostsViewStore()
  const openView = (): void => { ctx.layout.setCenterView('remote-hosts') }
  // Occupancy of the key-directory flow hole: true while the browse
  // directory-picker surface occupies it, so the pick affordance appears only
  // when the interaction it triggers actually exists.
  const keyDirectoryFlowSource = {
    getSnapshot: () => ctx.slots.entries('remoteHosts.keyDirectoryFlow').length > 0,
    subscribe: (listener: () => void) => ctx.slots.subscribe('remoteHosts.keyDirectoryFlow', listener),
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'remote-hosts', order: 20, locale: NS, store, inject: () => ({ openView }) }, RemoteHostsSidebarAction))
  ctx.slots.inject('center.view', () => ctx.slots.register({ name: 'center.view', id: 'remote-hosts', locale: NS, store,
    children: { 'remoteHosts.keyDirectoryFlow': { kind: 'single', scope: 'root' } },
    inject: () => ({ list: () => ctx.remote.remoteHosts.list(), upsert: (input: UpsertHostInput) => ctx.remote.remoteHosts.upsert(input), verify: (input: VerifyHostInput) => ctx.remote.remoteHosts.verify(input), keyFilePicker: () => ctx.remote.remoteHosts.keyFilePicker(), pickKeyFile: () => ctx.remote.remoteHosts.pickKeyFile(), connect: (id: RemoteHostId, secrets?: AuthSecrets) => ctx.remote.remoteHosts.connect({ id, ...(secrets === undefined ? {} : { secrets, storeCredentials: false }) }), openRemote: (id: RemoteHostId) => { const browser = (globalThis as { location?: Location; open?: typeof window.open }).open; const location = (globalThis as { location?: Location }).location; if (browser === undefined || location === undefined) return; const url = new URL(location.href); url.searchParams.set('dshRemoteHost', id); browser(url, '_blank', 'noopener,noreferrer') }, disconnect: (id: RemoteHostId) => ctx.remote.remoteHosts.disconnect(id), remove: (id: RemoteHostId) => ctx.remote.remoteHosts.removeHost(id), closeView: () => { ctx.layout.clearCenterView() }, hooks: { keyDirectoryFlow: keyDirectoryFlowSource } }) }, RemoteHostsView))
}
