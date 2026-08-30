/** Register Tavily's native search API in the aggregate `ctx.web` seam. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_PROVIDER_ID,
} from './provider.ts'
import type { TavilySearchProviderOptions } from './provider.ts'

export {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_PROVIDER_ID,
  mapTavilyResponse,
  mapTavilyResult,
} from './provider.ts'
export type { TavilySearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'
/** This function plugin contributes to the aggregate web service. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/** Configuration for the Tavily provider and its live settings section. */
export interface Config {
  /** Literal Tavily key; prefer `apiKeyEnv` for persisted configuration. */
  apiKey?: string
  /** Credential reference resolved for each search. */
  apiKeyEnv?: string
  /** Endpoint base; `/search` is appended. */
  baseURL?: string
  /** Request Tavily's optional raw result content. */
  includeRawContent?: boolean
  /** Default result count when a request omits `maxResults`. */
  maxResults?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(TAVILY_DEFAULT_BASE_URL),
  includeRawContent: z.boolean().default(false),
  maxResults: z.number().step(1).min(1),
})

/** Settings namespace for Tavily's endpoint, key reference, and request options. */
export const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = settingsNamespace('web-search-tavily')

function resolveOptions(ctx: Context, config: Config): TavilySearchProviderOptions {
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
    baseURL: config.baseURL ?? TAVILY_DEFAULT_BASE_URL,
    includeRawContent: config.includeRawContent ?? false,
    ...config.maxResults === undefined ? {} : { maxResults: config.maxResults },
  }
}

/** Register Tavily as one aggregate web provider with search capability. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })
  const provider = new TavilySearchProvider(() => resolveOptions(ctx, current()))
  ctx.web.registerProvider({
    id: TAVILY_PROVIDER_ID,
    search: {
      available: () => provider.available(),
      search: (request, signal) => provider.search(request, signal),
    },
  })
}
