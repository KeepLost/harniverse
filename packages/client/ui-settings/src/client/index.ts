/**
 * Settings domain base plugin, browser half. Provides `ctx.settingsScope`, the
 * settings-namespace Host transport every preference row binds its durable
 * section through, and owns the one authorization-aware settings description.
 * It depends on no `ui-*` presentation package, so any feature that
 * owns a preference can reach it: the settings SHELL — the `sidebar.settings`
 * occupant, its navigation, and the chrome — lives in ui-settings-general,
 * because a shell dependency on ui-sidebar would close a reference cycle
 * through ui-layout and ui-theme. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import { SettingsScopeBinder } from './settings-scope.ts'
import { SettingsDescribeMirror } from './settings-mirror.ts'

export type {
  SettingsGeneralItemOwnerProps, SettingsHeaderOwnerProps, SettingsOnboardingOwnerProps,
  SettingsPluginsTabOwnerProps, SettingsSectionOwnerProps, SettingsTriggerOwnerProps,
} from './contract/slots.ts'
export { SettingsScopeController, SettingsScopeBinder } from './settings-scope.ts'
export type { SettingsDescribeFace, SettingsDescribeView, SettingsMirrorSnapshot } from './settings-mirror.ts'

/**
 * Required services: the authenticated wire handle and forwarded invalidations.
 */
export const inject = ['connection', 'remote']

/**
 * Provide the settings-namespace scope service over one shared description.
 *
 * Constructing the service in this plugin's fiber keeps its traced methods
 * bound to each consuming plugin's context.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const mirror = new SettingsDescribeMirror(connection.api, connection.authentication)
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('settings/document-updated', () => { void mirror.load() }),
      ctx.remote.$on('settings/exposure-changed', () => { void mirror.load() }),
    ]
    void mirror.ensure()
    return () => {
      for (const dispose of disposers) dispose()
      mirror.dispose()
    }
  }, 'ui-settings: authorization-aware describe mirror')
  new SettingsScopeBinder(ctx, mirror)
}
