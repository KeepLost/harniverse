/** Locally authoritative settings sections; writes use the owners' registered validators. */
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Model and search settings synchronized by the local coordinator. */
export const SYNC_SETTINGS_NAMESPACES = [
  'llm-deepseek', 'llm-pi-ai', 'agent-default-model', 'model-profiles', 'model-routes',
  'web', 'web-search-deepseek', 'web-search-exa', 'web-search-perplexity',
  'web-search-tavily', 'web-search-brave', 'web-search-kagi', 'web-search-cloudflare', 'web-firecrawl',
] as const

/**
 * Replace supported registered user sections, resetting omitted sections to their defaults.
 * Namespace commits are independent; a failed call is safe to retry with the same full snapshot.
 * @param settings - live provider retaining namespace schemas and validation hooks.
 * @param snapshot - complete local user sections, never a redacted UI descriptor.
 */
export async function syncSettings(settings: SettingsProvider, snapshot: unknown): Promise<void> {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('remote-runtime: settings snapshot must be an object')
  }
  const prototype: unknown = Object.getPrototypeOf(snapshot)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('remote-runtime: settings snapshot must be a plain object')
  const registered = new Set(settings.describe({ redactSecrets: true }).map(entry => String(entry.ns)))
  const sections = new Map<string, object>()
  for (const [name, section] of Object.entries(snapshot as Record<string, unknown>)) {
    if (!SYNC_SETTINGS_NAMESPACES.some(allowed => allowed === name) || !registered.has(name)) {
      throw new Error(`remote-runtime: unsupported or unregistered settings namespace ${JSON.stringify(name)}`)
    }
    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      throw new TypeError(`remote-runtime: settings namespace ${JSON.stringify(name)} must be an object`)
    }
    sections.set(name, section)
  }
  for (const name of SYNC_SETTINGS_NAMESPACES) {
    if (!registered.has(name)) continue
    await settings.replace(settingsNamespace(name), sections.get(name) ?? {})
  }
}
