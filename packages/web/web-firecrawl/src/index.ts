/** Register Firecrawl Search and Scrape in the aggregate `ctx.web` seam. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { WebProvider } from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-web'
import {
  FirecrawlFetchProvider,
  FirecrawlSearchProvider,
  FIRECRAWL_DEFAULT_BASE_URL,
  FIRECRAWL_DEFAULT_MAX_CHARS,
  FIRECRAWL_DEFAULT_SEARCH_CONTENT_MAX_CHARS,
  FIRECRAWL_PROVIDER_ID,
} from './provider.ts'
import type { FirecrawlProviderOptions } from './provider.ts'

export {
  FirecrawlFetchProvider,
  FirecrawlSearchProvider,
  FIRECRAWL_DEFAULT_BASE_URL,
  FIRECRAWL_DEFAULT_MAX_CHARS,
  FIRECRAWL_DEFAULT_SEARCH_CONTENT_MAX_CHARS,
  FIRECRAWL_PROVIDER_ID,
  mapFirecrawlScrapeResponse,
  mapFirecrawlSearchResponse,
  mapFirecrawlSearchResult,
} from './provider.ts'
export type {
  FirecrawlFetchProviderOptions,
  FirecrawlProviderOptions,
  FirecrawlSearchProviderOptions,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-firecrawl'
/** This function plugin contributes both capabilities to the aggregate seam. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'FIRECRAWL_API_KEY'

/** Configuration for Firecrawl Search/Scrape and its live settings section. */
export interface Config {
  /** Optional literal Firecrawl key; prefer `apiKeyEnv` for persisted configuration. */
  apiKey?: string
  /** Credential reference resolved separately for each search or fetch. */
  apiKeyEnv?: string
  /** Endpoint base; `/v2/search` and `/v2/scrape` are appended. */
  baseURL?: string
  /** Ask Search to include markdown/raw content in each result. Defaults false. */
  includeSearchContent?: boolean
  /** Maximum characters of optional per-result search content. */
  searchContentMaxChars?: number
  /** Maximum characters returned from a Scrape markdown body. */
  maxChars?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(FIRECRAWL_DEFAULT_BASE_URL),
  includeSearchContent: z.boolean().default(false),
  searchContentMaxChars: z.number().step(1).min(1).default(FIRECRAWL_DEFAULT_SEARCH_CONTENT_MAX_CHARS),
  maxChars: z.number().step(1).min(1).default(FIRECRAWL_DEFAULT_MAX_CHARS),
})

/** Settings namespace for Firecrawl's endpoint, credential, and bounded content options. */
export const WEB_FIRECRAWL_SETTINGS_NAMESPACE = settingsNamespace('web-firecrawl')

function resolveOptions(ctx: Context, config: Config): FirecrawlProviderOptions {
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
    baseURL: config.baseURL ?? FIRECRAWL_DEFAULT_BASE_URL,
    includeSearchContent: config.includeSearchContent ?? false,
    searchContentMaxChars: config.searchContentMaxChars ?? FIRECRAWL_DEFAULT_SEARCH_CONTENT_MAX_CHARS,
    maxChars: config.maxChars ?? FIRECRAWL_DEFAULT_MAX_CHARS,
  }
}

/** Register Firecrawl Search and Scrape as one lifecycle unit. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_FIRECRAWL_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  const search = new FirecrawlSearchProvider(() => resolveOptions(ctx, current()))
  const fetch = new FirecrawlFetchProvider(() => resolveOptions(ctx, current()))
  const provider: WebProvider = {
    id: FIRECRAWL_PROVIDER_ID,
    search: {
      available: () => search.available(),
      search: (request, signal) => search.search(request, signal),
    },
    fetch: {
      available: () => fetch.available(),
      fetch: (request, signal) => fetch.fetch(request, signal),
    },
  }
  ctx.web.registerProvider(provider)
}
