/** Register Cloudflare's Web Search API (AI Gateway) in the aggregate `ctx.web` seam. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  CloudflareSearchProvider,
  CLOUDFLARE_DEFAULT_BASE_URL,
  CLOUDFLARE_DEFAULT_ENGINE,
  CLOUDFLARE_DEFAULT_GATEWAY_ID,
  CLOUDFLARE_DEFAULT_SNIPPET_MAX_CHARS,
  CLOUDFLARE_ENGINES,
  CLOUDFLARE_PROVIDER_ID,
} from './provider.ts'
import type { CloudflareSearchEngine, CloudflareSearchProviderOptions } from './provider.ts'

export {
  CloudflareSearchProvider,
  CLOUDFLARE_DEFAULT_BASE_URL,
  CLOUDFLARE_DEFAULT_ENGINE,
  CLOUDFLARE_DEFAULT_GATEWAY_ID,
  CLOUDFLARE_DEFAULT_SNIPPET_MAX_CHARS,
  CLOUDFLARE_ENGINES,
  CLOUDFLARE_MAX_RESULTS,
  CLOUDFLARE_PROVIDER_ID,
  mapCloudflareItem,
  mapCloudflareResponse,
} from './provider.ts'
export type { CloudflareSearchEngine, CloudflareSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-cloudflare'
/** This function plugin contributes to the aggregate web service. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'CLOUDFLARE_API_TOKEN'

/** Configuration for Cloudflare Web Search and its live settings section. */
export interface Config {
  /** Literal API token; prefer `apiKeyEnv` for persisted configuration. */
  apiKey?: string
  /** Credential reference resolved for each search. */
  apiKeyEnv?: string
  /** Cloudflare account id; required before the first search. */
  accountId?: string
  /** AI Gateway the search is routed through. */
  gatewayId?: string
  /** Upstream engine Cloudflare uses: `ceramic`, `exa`, or `linkup`. */
  engine?: CloudflareSearchEngine
  /** Alias of a provider key stored on the gateway, to bill the engine directly. */
  byokAlias?: string
  /** Cloudflare API base; `/accounts/{accountId}/ai/websearch/` is appended. */
  baseURL?: string
  /** Maximum characters kept from each result description. */
  snippetMaxChars?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  accountId: z.string(),
  gatewayId: z.string().default(CLOUDFLARE_DEFAULT_GATEWAY_ID),
  engine: z.union(CLOUDFLARE_ENGINES).default(CLOUDFLARE_DEFAULT_ENGINE),
  byokAlias: z.string(),
  baseURL: z.string().default(CLOUDFLARE_DEFAULT_BASE_URL),
  snippetMaxChars: z.number().step(1).min(1).default(CLOUDFLARE_DEFAULT_SNIPPET_MAX_CHARS),
})

/** Settings namespace for Cloudflare's account, gateway, engine, endpoint, and token reference. */
export const WEB_SEARCH_CLOUDFLARE_SETTINGS_NAMESPACE = settingsNamespace('web-search-cloudflare')

function resolveOptions(ctx: Context, config: Config): CloudflareSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? CLOUDFLARE_DEFAULT_BASE_URL,
    ...config.accountId === undefined ? {} : { accountId: config.accountId },
    gatewayId: config.gatewayId ?? CLOUDFLARE_DEFAULT_GATEWAY_ID,
    engine: config.engine ?? CLOUDFLARE_DEFAULT_ENGINE,
    ...config.byokAlias === undefined ? {} : { byokAlias: config.byokAlias },
    snippetMaxChars: config.snippetMaxChars ?? CLOUDFLARE_DEFAULT_SNIPPET_MAX_CHARS,
  }
}

/** Register Cloudflare as one aggregate web provider with search capability. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_CLOUDFLARE_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  const provider = new CloudflareSearchProvider(() => resolveOptions(ctx, current()))
  ctx.web.registerProvider({
    id: CLOUDFLARE_PROVIDER_ID,
    search: {
      available: () => provider.available(),
      search: (request, signal) => provider.search(request, signal),
    },
  })
}
