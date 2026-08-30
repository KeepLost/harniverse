/** Register Brave Search in the aggregate `ctx.web` capability seam. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  BraveSearchProvider,
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_PROVIDER_ID,
} from './provider.ts'
import type { BraveSearchProviderOptions } from './provider.ts'

export {
  BraveSearchProvider,
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_PROVIDER_ID,
  mapBraveResponse,
  mapBraveResult,
} from './provider.ts'
export type { BraveSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brave'
/** This function plugin contributes to the aggregate web service. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'

/** Configuration for Brave Search and its live settings section. */
export interface Config {
  /** Literal subscription token; prefer `apiKeyEnv` for persisted configuration. */
  apiKey?: string
  /** Credential reference resolved for each search. */
  apiKeyEnv?: string
  /** Brave web endpoint base; `/search` is appended. */
  baseURL?: string
  /** Default result count when an operation omits `maxResults`. */
  maxResults?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(BRAVE_DEFAULT_BASE_URL),
  maxResults: z.number().step(1).min(1),
})

/** Settings namespace for Brave's endpoint, key reference, and result count. */
export const WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE = settingsNamespace('web-search-brave')

function resolveOptions(ctx: Context, config: Config): BraveSearchProviderOptions {
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
    baseURL: config.baseURL ?? BRAVE_DEFAULT_BASE_URL,
    ...config.maxResults === undefined ? {} : { maxResults: config.maxResults },
  }
}

/** Register Brave as one aggregate web provider with search capability. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  const provider = new BraveSearchProvider(() => resolveOptions(ctx, current()))
  ctx.web.registerProvider({
    id: BRAVE_PROVIDER_ID,
    search: {
      available: () => provider.available(),
      search: (request, signal) => provider.search(request, signal),
    },
  })
}
