/**
 * Browser half of the remote-host management surface: the dashboard 远程主机
 * tab over the host-authority remote-hosts Remote, plus the machine
 * indicator beside the workspace list.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-remote-hosts/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-dashboard/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteHostsView } from './RemoteHostsView.tsx'
import { en, NS, zh, type RemoteHostsKey } from './locales.ts'
import type { AuthSecrets, RemoteHostId, UpsertHostInput, VerifyHostInput } from '@deepseek-ai/dsh-remote-hosts/types'
import { MachineTarget } from './MachineTarget.tsx'
import { en as targetEn, zh as targetZh, NS as targetNS, type MachineTargetKey } from './target-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { remoteHosts: RemoteHostsKey } }
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { machineTarget: MachineTargetKey } }

export const inject = ['slots', 'locale', 'remote', 'remote.remoteHosts', 'layout', 'connection']

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'ui-remote-hosts: dictionaries')
  ctx.effect(() => ctx.locale.register(targetNS, { en: targetEn, zh: targetZh }), 'ui-remote-hosts: machine dictionary')
  const t = ctx.locale.bind(NS)
  const openRemote = (id: RemoteHostId): Promise<void> => {
    const switched = connection.switchTarget({ kind: 'remote', id })
    ctx.layout.clearCenterView()
    return switched
  }
  ctx.slots.inject('dashboard.center.tab', () => ctx.slots.register({
    name: 'dashboard.center.tab', id: 'remote-hosts', order: 20, locale: NS, label: () => t('nav'),
    inject: () => ({
      list: () => ctx.remote.remoteHosts.list(),
      upsert: (input: UpsertHostInput) => ctx.remote.remoteHosts.upsert(input),
      verify: (input: VerifyHostInput) => ctx.remote.remoteHosts.verify(input),
      keyFilePicker: () => ctx.remote.remoteHosts.keyFilePicker(),
      pickKeyFile: () => ctx.remote.remoteHosts.pickKeyFile(),
      listKeyFiles: (input: { path?: string }) => ctx.remote.remoteHosts.listKeyFiles(input),
      connect: (id: RemoteHostId, secrets?: AuthSecrets) => ctx.remote.remoteHosts.connect({
        id, ...(secrets === undefined ? {} : { secrets, storeCredentials: false }),
      }),
      openRemote,
      disconnect: (id: RemoteHostId) => ctx.remote.remoteHosts.disconnect(id),
      remove: (id: RemoteHostId) => ctx.remote.remoteHosts.removeHost(id),
    }),
  }, RemoteHostsView))
  ctx.slots.inject('sidebar.workspaces.machine', () => ctx.slots.register({
    name: 'sidebar.workspaces.machine', locale: targetNS,
    inject: () => ({
      hooks: { machine: connection.target },
      nameOf: async (id: string) => {
        const result = await ctx.remote.remoteHosts.list()
        return result.ok ? result.value.find(host => host.id === id)?.name : undefined
      },
      returnToHost: () => {
        const switched = connection.switchTarget({ kind: 'host' })
        ctx.layout.clearCenterView()
        return switched
      },
    }),
  }, MachineTarget))
}
