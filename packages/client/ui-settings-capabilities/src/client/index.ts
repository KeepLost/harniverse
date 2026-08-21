/** Agent Profile composition editor and Session runtime capability view. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CapabilityCompositionTab, type CapabilityCompositionTabInjected } from './CapabilityCompositionTab.tsx'
import { CapabilityCompositionController, type CapabilityCompositionWire } from './controller.ts'
import { SessionCapabilitiesView, type SessionCapabilitiesViewInjected } from './SessionCapabilitiesView.tsx'
import { en, zh, type CapabilityCompositionLocaleKey } from './locales.ts'

export type { CapabilityCompositionTabInjected, CapabilityCompositionTabProps } from './CapabilityCompositionTab.tsx'
export type { CapabilityCompositionLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Profile composition and Session assembly copy. */
    'settings.capabilityComposition': CapabilityCompositionLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.capabilityComposition'

/** Services required by the Settings contribution and its two wire faces. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.capabilityManagement']

/** Contribute Profile composition as a separate Plugins tab. */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const management = ctx.remote.capabilityManagement
  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }, operation: string): T => {
    if (result.ok) return result.value
    throw new Error(`${operation} failed: ${result.error.code}: ${result.error.message}`)
  }
  const wire: CapabilityCompositionWire = {
    listProfiles: async () => {
      const response = await api.agentPresets.list({})
      if (!response.result.ok) {
        throw new Error(`agentPreset.list failed: ${response.result.error.code}: ${response.result.error.message}`)
      }
      return response.result.value.presets
        .filter(profile => profile.broken === undefined)
        .map(profile => ({ id: profile.id, name: profile.name ?? profile.id }))
    },
    catalog: async target => unwrap(await management.catalog(target), 'capabilityManagement.catalog'),
    plan: async (target, changes, expectedRevision) =>
      unwrap(await management.plan(target, changes, expectedRevision), 'capabilityManagement.plan'),
    apply: async (planId, expectedRevision) =>
      unwrap(await management.apply(planId, expectedRevision), 'capabilityManagement.apply'),
  }
  const controller = new CapabilityCompositionController(wire)
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-capabilities: dictionaries')
  ctx.effect(
    () => ctx.on('connection/reset', () => { void controller.load() }),
    'ui-settings-capabilities: reconnect refresh',
  )

  const injected = (): CapabilityCompositionTabInjected => ({
    hooks: { capabilityComposition: controller.store },
    load: () => controller.load(),
    selectTarget: target => controller.selectTarget(target),
    setSelection: (capabilityId, selection) => { controller.setSelection(capabilityId, selection) },
    setMembers: (capabilityId, members) => { controller.setMembers(capabilityId, members) },
    setConfig: (capabilityId, config) => { controller.setConfig(capabilityId, config) },
    discard: () => { controller.discard() },
    preview: () => controller.preview(),
    apply: () => controller.apply(),
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'capabilities',
    order: 5,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, CapabilityCompositionTab))

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'capabilities',
    order: 20,
    label: () => t('sessionView'),
    locale: NS,
    inject: (sessionId: SessionId): SessionCapabilitiesViewInjected => ({
      load: async () => unwrap(await management.session(sessionId), 'capabilityManagement.session'),
    }),
  }, SessionCapabilitiesView))
}
