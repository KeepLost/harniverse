/** Read-only Host plugin inventory registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabInjected } from './PluginInventorySettingsTab.tsx'
import { hostBase } from './host-base.ts'
import { en, zh, type PluginInventoryLocaleKey } from './locales.ts'

export type { PluginInventorySettingsTabInjected, PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
export type { PluginInventoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-only Host plugin inventory copy. */
    'settings.pluginInventory': PluginInventoryLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInventory'

/** Services required by the Settings registration and generated Remote face. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']

/** Contribute the lazy inventory tab to the Plugins settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-inventory: dictionaries')

  const t = ctx.locale.bind(NS)
  const list: PluginInventorySettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const diagnose: PluginInventorySettingsTabInjected['diagnose'] = async () => {
    const result = await ctx.remote.pluginInventory.diagnose()
    if (!result.ok) {
      throw new Error(`pluginInventory.diagnose failed: ${result.error.code}: ${result.error.message}`)
    }
    return result.value
  }
  const exportPlugin: PluginInventorySettingsTabInjected['exportPlugin'] = async (moduleName) => {
    const url = new URL('/api/plugin.export', hostBase((globalThis as { location?: { origin?: string } }).location?.origin))
    url.searchParams.set('package', moduleName)
    const probe = await fetch(url, { method: 'HEAD' })
    if (!probe.ok) {
      const detail = await probe.text().catch(() => '')
      throw new Error(`HTTP ${probe.status}${detail === '' ? '' : ` ${detail}`}`)
    }
    const anchor = document.createElement('a')
    anchor.href = url.toString()
    anchor.download = `${moduleName.replace(/[^A-Za-z0-9@._-]/g, '_')}.tgz`
    anchor.click()
  }
  const injected = (): PluginInventorySettingsTabInjected => ({ list, diagnose, exportPlugin })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'all',
    order: 10,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PluginInventorySettingsTab))
}
