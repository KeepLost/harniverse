/**
 * `@deepseek-ai/dsh-web-search-exa`: registers an Exa-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-llm-deepseek`
 * registers an adapter into `ctx.llm`. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-exa
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ExaSearchProvider,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
} from './provider.ts'
import type { ExaSearchProviderOptions } from './provider.ts'

export {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
  ExaSearchProvider,
} from './provider.ts'
export type { ExaSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'EXA_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Exa API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `EXA_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Retrieval mode sent as Exa's `type`. Defaults to `auto`. */
  searchType?: 'auto' | 'keyword' | 'neural'
  /** Default result count when a request carries no `maxResults`. Omitted = none. */
  numResults?: number
  /** Highlight sentences requested per result. Defaults to 1. */
  highlightsPerResult?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(EXA_DEFAULT_BASE_URL),
  searchType: z.union(['auto', 'keyword', 'neural'] as const).default(EXA_DEFAULT_SEARCH_TYPE),
  numResults: z.number().step(1).min(1),
  highlightsPerResult: z.number().step(1).min(1).default(EXA_DEFAULT_HIGHLIGHTS_PER_RESULT),
})

/** Settings namespace carrying this provider's endpoint, request options, and key reference. */
export const WEB_SEARCH_EXA_SETTINGS_NAMESPACE = settingsNamespace('web-search-exa')

/** Project the current settings section into options for one search operation. */
function resolveOptions(ctx: Context, config: Config): ExaSearchProviderOptions {
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
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    searchType: config.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
    highlightsPerResult: config.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
  }
}

/** Register the Exa search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_EXA_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new ExaSearchProvider(() => resolveOptions(ctx, current())))
}
