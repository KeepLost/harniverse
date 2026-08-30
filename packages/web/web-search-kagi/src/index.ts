/** Register Kagi's native search API in the aggregate `ctx.web` seam. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { KagiSearchProvider, KAGI_DEFAULT_BASE_URL, KAGI_PROVIDER_ID } from './provider.ts'
import type { KagiSearchProviderOptions } from './provider.ts'

export {
  KagiSearchProvider,
  KAGI_DEFAULT_BASE_URL,
  KAGI_PROVIDER_ID,
  mapKagiResponse,
  mapKagiResult,
} from './provider.ts'
export type { KagiSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-kagi'
/** This function plugin contributes to the aggregate web service. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'KAGI_API_KEY'

/** Configuration for Kagi and its live settings section. */
export interface Config {
  /** Literal Kagi token; prefer `apiKeyEnv` for persisted configuration. */
  apiKey?: string
  /** Credential reference resolved for each search. */
  apiKeyEnv?: string
  /** Kagi API base; `/search` is appended. */
  baseURL?: string
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(KAGI_DEFAULT_BASE_URL),
})

/** Settings namespace for Kagi's endpoint and key reference. */
export const WEB_SEARCH_KAGI_SETTINGS_NAMESPACE = settingsNamespace('web-search-kagi')

function resolveOptions(ctx: Context, config: Config): KagiSearchProviderOptions {
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
    baseURL: config.baseURL ?? KAGI_DEFAULT_BASE_URL,
  }
}

/** Register Kagi as one aggregate web provider with search capability. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_KAGI_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  const provider = new KagiSearchProvider(() => resolveOptions(ctx, current()))
  ctx.web.registerProvider({
    id: KAGI_PROVIDER_ID,
    search: {
      available: () => provider.available(),
      search: (request, signal) => provider.search(request, signal),
    },
  })
}
