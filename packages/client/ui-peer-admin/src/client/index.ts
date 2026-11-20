/**
 * Browser half of the paired-peer governance surface: the dashboard 配对同伴
 * tab over the host-authority peer-admin Remotes, refreshed by the forwarded
 * pairing events.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-peer-host/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-dashboard/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PeersView } from './PeersView.tsx'
import type { PeerSurface as PeerSurfaceLike } from '@deepseek-ai/dsh-peer-host/types'
import { en, NS, zh, type PeerAdminKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { peerAdmin: PeerAdminKey } }

export const inject = ['slots', 'locale', 'remote', 'remote.peer']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'ui-peer-admin: dictionaries')
  const t = ctx.locale.bind(NS)
  // Pairing events forwarded from the host bump this tick; the view re-lists on every bump.
  const listeners = new Set<() => void>()
  let tick = 0
  const peersTick = {
    getSnapshot: (): number => tick,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const bump = (): void => {
    tick += 1
    for (const listener of listeners) listener()
  }
  ctx.effect(() => ctx.remote.$on('peer/paired', bump), 'ui-peer-admin: paired refresh')
  ctx.effect(() => ctx.remote.$on('peer/removed', bump), 'ui-peer-admin: removed refresh')
  ctx.slots.inject('dashboard.center.tab', () => ctx.slots.register({
    name: 'dashboard.center.tab', id: 'peer-admin', order: 30, locale: NS, label: () => t('nav'),
    inject: () => ({
      hooks: { peersTick },
      list: () => ctx.remote.peer.list(),
      remove: (input: { instanceId: string }) => ctx.remote.peer.remove(input),
      setSurface: (input: { instanceId: string; surface: PeerSurfaceLike }) => ctx.remote.peer.setSurface(input),
      approveSurface: (input: { instanceId: string }) => ctx.remote.peer.approveSurface(input),
      rejectSurface: (input: { instanceId: string }) => ctx.remote.peer.rejectSurface(input),
      setBudget: (input: { instanceId: string; monthlyTurns?: number }) => ctx.remote.peer.setBudget(input),
      audit: (input: { instanceId: string }) => ctx.remote.peer.audit(input),
    }),
  }, PeersView))
}
