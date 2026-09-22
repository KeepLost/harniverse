/**
 * Browser carrier panel plugin, node half: registers the `browser` settings
 * section carrying the optional navigation allowlist, with the cordis entry
 * config as its base layer. The browser half ships via exports["./client"],
 * discovered through the package.json dsh client declaration.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace of the browser panel's navigation policy section. */
export const BROWSER_SETTINGS_NAMESPACE = settingsNamespace('browser')

/** Entry config of the browser panel: the durable navigation policy. */
export interface BrowserPanelConfig {
  /** Exact hostnames the panel may navigate to; unset means open browsing. */
  allowedHosts?: string[]
}

/** Stored browser panel settings schema. */
export const Config: z<BrowserPanelConfig> = z.object({
  allowedHosts: z.array(String),
})

/** Stable Cordis plugin name. */
export const name = 'client-ui-browser'

/** The section is registered only while a settings provider is available. */
export const inject = ['settings']

/** Characters an allowlist entry must not carry: it is a bare hostname. */
const NON_HOST_CHARS = /[/@:?#\s]/

/**
 * Fail loudly on allowlist entries that are not bare hostnames: URLs,
 * origins with ports, userinfo, paths, or blank entries would silently
 * never match a reviewed hostname and read as an empty policy.
 * @param hosts - configured allowlist entries.
 * @throws `Error` naming the first invalid entry.
 */
function assertBareHosts(hosts: readonly string[]): void {
  for (const host of hosts) {
    if (host === '' || NON_HOST_CHARS.test(host)) {
      throw new Error(
        `client-ui-browser allowedHosts entries must be bare hostnames, received ${JSON.stringify(host)}`,
      )
    }
  }
}

/**
 * Register the browser panel settings namespace with the entry config as the
 * base layer, so the browser half's scope resolves deployment policy and the
 * settings service persists user overrides.
 * @param ctx - Cordis context carrying the settings service.
 * @param config - entry config (the deployment allowlist).
 */
export function apply(ctx: Context, config: BrowserPanelConfig = {}): void {
  assertBareHosts(config.allowedHosts ?? [])
  ctx.settings.register(BROWSER_SETTINGS_NAMESPACE, Config, { base: config })
}
