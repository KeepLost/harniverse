/**
 * Register the DeepSeek Search and Fetch APIs in `ctx.web` as `deepseek-search-api`
 * and `deepseek-fetch-api`. Each operation is one direct API request without an
 * auxiliary model call; both providers read one live settings section, so a
 * committed endpoint or credential change applies to the next operation without
 * re-registration. `web.searchProvider` and `web.fetchProvider` select them.
 * @module @deepseek-ai/dsh-web-deepseek-api
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { DeepSeekFetchApiProvider } from './fetch.ts'
import type { DeepSeekFetchApiOptions } from './fetch.ts'
import { DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_WEB_API_BASE_URL, DeepSeekSearchApiProvider } from './search.ts'
import type { DeepSeekSearchApiOptions } from './search.ts'

export { DEEPSEEK_FETCH_API_PROVIDER_ID, DeepSeekFetchApiProvider } from './fetch.ts'
export type { DeepSeekFetchApiOptions } from './fetch.ts'
export {
  DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_SEARCH_API_PROVIDER_ID, DEEPSEEK_WEB_API_BASE_URL,
  DEEPSEEK_WEB_API_GUIDANCE, DeepSeekSearchApiProvider, mapSearchResponse,
} from './search.ts'
export type { DeepSeekSearchApiOptions } from './search.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-deepseek-api'

/** The web seam both providers register into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Plugin config (all optional — the schema defaults fill every field but the literal key). */
export interface Config {
  /** Literal DeepSeek API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each operation; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** API base including its path prefix; `/search` and `/fetch` are appended. Defaults to the official endpoint. */
  baseURL?: string
  /** Search API results per search, from 1 through 50; a smaller request bound wins. Defaults to 10. */
  count?: number
  /** Send the triggering user question, bounded to 128 characters, as `ori_question`. Defaults to false. */
  sendOriginalQuestion?: boolean
}

/** A settings-scope-resolved section: every schema-defaulted field carries its value. */
type ResolvedConfig = Required<Pick<Config, 'apiKeyEnv' | 'baseURL' | 'count' | 'sendOriginalQuestion'>> & Pick<Config, 'apiKey'>

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEEPSEEK_WEB_API_BASE_URL),
  count: z.number().step(1).min(1).max(50).default(DEEPSEEK_DEFAULT_COUNT),
  sendOriginalQuestion: z.boolean().default(false),
})

/** Settings namespace carrying this package's endpoint, result-count, and key settings. */
export const WEB_DEEPSEEK_API_SETTINGS_NAMESPACE = settingsNamespace('web-deepseek-api')

/**
 * Read the text of the latest human prompt, the question that triggered the
 * current turn. Injected user-role context carries another source kind.
 * @param session - the initiating Session, when the search runs inside one.
 * @returns the prompt's joined text blocks, or undefined without a prompt.
 */
function latestUserQuestion(session: Session | undefined): string | undefined {
  const prompt = session?.deriveMessages().findLast(
    message => message.role === 'user' && message.source.kind === 'user',
  )
  if (prompt === undefined) return undefined
  return prompt.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Project one resolved section into the authentication values an operation
 * serves. Environment fallbacks stay here rather than in the providers: every
 * value they read is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section, schema defaults resolved.
 * @returns authentication sources for one operation.
 */
function resolveAuth(
  ctx: Context,
  config: ResolvedConfig,
): { apiKey?: string; resolveApiKey: () => Promise<string | undefined>; apiKeyEnv: ReturnType<typeof credentialRef> } {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const rawApiKey = config.apiKey
  const literalApiKey = rawApiKey === undefined || rawApiKey.length === 0 ? undefined : rawApiKey
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
  }
}

/**
 * Register the Search API and Fetch API providers over one live settings section.
 * @param ctx - plugin context owning both registrations.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config: Config): void {
  /* v8 ignore next -- setSource overwrites this initializer before any read; it exists for definite assignment */
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_DEEPSEEK_API_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: both providers project the
    // section per operation, so a committed change needs no re-registration.
    onChange: () => {},
  })
  const searchApi = new DeepSeekSearchApiProvider((): DeepSeekSearchApiOptions => {
    // The settings scope resolves schema defaults, so the section is complete at read time.
    const section = current() as ResolvedConfig
    const question = section.sendOriginalQuestion
      ? (): string | undefined => latestUserQuestion(ctx.get('agents')?.currentInitiator()?.session)
      : undefined
    return {
      ...resolveAuth(ctx, section),
      baseURL: section.baseURL,
      count: section.count,
      ...question === undefined ? {} : { originalQuestion: question },
    }
  })
  const fetchApi = new DeepSeekFetchApiProvider((): DeepSeekFetchApiOptions => {
    const section = current() as ResolvedConfig
    return { ...resolveAuth(ctx, section), baseURL: section.baseURL }
  })
  ctx.web.registerSearchProvider({
    id: searchApi.id,
    available: () => searchApi.available(),
    search: (request, signal) => searchApi.search(request, signal),
  })
  ctx.web.registerFetchProvider({
    id: fetchApi.id,
    available: () => fetchApi.available(),
    fetch: (request, signal) => fetchApi.fetch(request, signal),
  })
}
