/**
 * MCP management settings section, browser half. One `settings.section`
 * entry (id `mcp`) whose page lists this machine's user-configured MCP
 * servers: the `mcp` settings scope carries the durable rows and every
 * write, the mcpManagement Remote carries live connection state and the
 * restart operation, and per-preset capability composition supplies the
 * read-only "exposed by" references. Configuration, connections, and
 * restart all live on the machine the page is connected to.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the mcpManagement Remote namespace merge onto TypertClientRemote.
import type {} from '@deepseek-ai/dsh-mcp-user-config/remote'
// Type-only: pulls the settings SlotMap merge (settings.section / settings.nav.icon)
// and the ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { McpSection } from './McpSection.tsx'
import { McpSectionController } from './section-store.ts'
import type { McpSettingsServers } from './section-store.ts'
import { McpNavIcon } from './NavIcon.tsx'
import { en, NS, zh } from './locales.ts'
import type { McpLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP management section copy. */
    'settings.mcp': McpLocaleKey
  }
}

/** Settings namespace of the `mcp` section the page binds. */
const MCP_SETTINGS_NS = 'mcp'

/** Required services: slots, locale, the Remote transport, and the settings scope. */
export const inject = ['slots', 'locale', 'remote', 'settingsScope']

/**
 * Client plugin body: register the dictionaries, the settings section, and
 * its nav glyph.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: dictionaries')

  const scope = ctx.settingsScope.bind<McpSettingsServers>({ namespace: MCP_SETTINGS_NS })

  /**
   * Read the roster ids one page load needs; the legacy agentPreset face is
   * the roster's own source of truth, so the page never guesses presets.
   */
  const presetIds = async (): Promise<readonly string[]> => {
    const api = (ctx.get('connection') as { api?: { agentPresets?: { list: () => Promise<{ result: { ok: true; value: { presets: ReadonlyArray<{ id: string }> } } } | { result: { ok: false } }> } } } | undefined)?.api
    const response = await api?.agentPresets?.list()
    if (response === undefined || !response.result.ok) return []
    return response.result.value.presets.map(preset => preset.id)
  }

  /**
   * Decode one capability id back to its serverName. The host's mcp-server
   * adapter derives ids as `mcp-server:` + hex of the serverName; spelled
   * here so the browser bundle never imports a host package's runtime values.
   */
  const serverNameOfCapabilityId = (id: string): string => {
    const bytes = new Uint8Array((id.length - 'mcp-server:'.length) / 2)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(id.slice('mcp-server:'.length + index * 2, 'mcp-server:'.length + index * 2 + 2), 16)
    }
    return new TextDecoder().decode(bytes)
  }

  /** Read one preset's selected MCP serverNames from its capability catalog. */
  const selectedServerNames = async (presetId: string): Promise<readonly string[]> => {
    const catalog = await ctx.remote.capabilityManagement.catalog({ kind: 'agent-profile', agentProfile: presetId })
    if (!catalog.ok) return []
    const names: string[] = []
    for (const entry of catalog.value.entries) {
      if (entry.kind !== 'mcp-server' || !entry.selected) continue
      names.push(serverNameOfCapabilityId(entry.id))
    }
    return names
  }

  const controller = new McpSectionController(scope, {
    status: () => ctx.remote.mcpManagement.status(),
    restart: serverId => ctx.remote.mcpManagement.restart(serverId),
  }, { presetIds, selectedServerNames })

  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp',
    // After Plugins and Governor, before Agent Presets: external tool
    // integrations sit with deployment capabilities, ahead of composing them.
    order: 17,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      hooks: { mcpSection: controller.store },
      scope: { getSnapshot: () => scope.getSnapshot() },
      refresh: () => controller.refresh(),
      writeServers: (servers: ReadonlyArray<NonNullable<McpSettingsServers['servers']>[number]>) => controller.writeServers(servers),
      restart: (id: string) => controller.restart(id),
    }),
  }, McpSection))
  ctx.slots.inject('settings.nav.icon', () => ctx.slots.register({
    name: 'settings.nav.icon',
    key: 'mcp',
  }, McpNavIcon))

  ctx.effect(() => {
    controller.start()
    return () => { controller.stop() }
  }, 'ui-settings-mcp: controller lifecycle')
}
