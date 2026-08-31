/**
 * Service Definition for the web access capability seam (`ctx.web`): registries and provider-selecting execution for search and
 * fetch. Duplicate ids are rejected. At execution time, an explicit provider
 * wins over the configured capability default; without either, execution fails
 * rather than selecting or falling back to another provider.
 * @module @deepseek-ai/dsh-web
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebProviderCapability,
  WebProviderInfo,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebProviderCapability,
  WebProviderInfo,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** Explicit provider id from the operation, if any. */
  readonly requestedId?: string
  /** The configured default provider id for this capability, if any. */
  readonly configuredId?: string
  /** Capability name used in diagnostics. */
  readonly capability: WebProviderCapability
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the web seam. `searchProvider` / `fetchProvider` set the capability
 * defaults; both are optional. Operational overrides such as environment
 * variables must feed these same fields rather than introduce a hidden fallback.
 */
export interface WebRuntimeConfig {
  /** Default search provider id. Omitted = require an explicit operation provider. */
  readonly searchProvider?: string
  /** Default fetch provider id. Omitted = require an explicit operation provider. */
  readonly fetchProvider?: string
}

/** Live settings owned by the WebRuntime search-provider selector. */
export interface WebSettings {
  /** Default search provider id used when a search omits its provider. */
  readonly searchProvider?: string
  /** Default fetch provider id used when a fetch omits its provider. */
  readonly fetchProvider?: string
}

/** Settings namespace for the provider-neutral WebRuntime selector. */
export const WEB_SETTINGS_NAMESPACE = settingsNamespace('web')

/** Schema exposed to settings clients for both capability defaults. */
export const WEB_SETTINGS_SCHEMA: z<WebSettings> = z.object({
  searchProvider: z.string(),
  fetchProvider: z.string(),
})

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No operation or configured id → `WEB_PROVIDER_DEFAULT_MISSING`.
 */
export class WebRuntime extends Service {
  /**
   * Provider selection config. Operational env overrides seed the SAME default
   * fields: `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` are
   * equivalent to `searchProvider` / `fetchProvider`, not fallback providers.
   */
  static Config: z<WebRuntimeConfig> = z.object({
    searchProvider: z.string(),
    fetchProvider: z.string(),
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private searchSettings: () => WebSettings

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web')
    const searchProvider = config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER
    const fetchProvider = config.fetchProvider ?? process.env.DSH_WEB_FETCH_PROVIDER
    const entry: WebSettings = {
      ...searchProvider === undefined ? {} : { searchProvider },
      ...fetchProvider === undefined ? {} : { fetchProvider },
    }
    this.searchSettings = () => entry
    installSettingsSection(ctx, WEB_SETTINGS_NAMESPACE, WEB_SETTINGS_SCHEMA, entry, {
      setSource: (source) => {
        this.searchSettings = source
      },
      onChange: () => {},
    })
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider({ id: provider.id, search: provider })
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider({ id: provider.id, fetch: provider })
  }

  /**
   * Register one provider's available capabilities as one lifecycle unit.
   * @param provider - the aggregate provider and its optional capabilities.
   * @returns the disposer that unregisters every capability contributed by the provider.
   */
  registerProvider(provider: WebProvider): () => void {
    if (provider.search === undefined && provider.fetch === undefined) {
      throw new WebError(`web provider "${provider.id}" declares no capabilities`, 'WEB_PROVIDER_INVALID')
    }
    if (provider.search !== undefined && this.searchProviders.has(provider.id)
      || provider.fetch !== undefined && this.fetchProviders.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const searchProviders = this.searchProviders
    const fetchProviders = this.fetchProviders
    const dispose = this.ctx.effect(function* () {
      if (provider.search !== undefined) {
        const search = provider.search
        searchProviders.set(provider.id, {
          id: provider.id,
          available: () => search.available(),
          search: (request, signal) => search.search(request, signal),
        })
      }
      if (provider.fetch !== undefined) {
        const fetch = provider.fetch
        fetchProviders.set(provider.id, {
          id: provider.id,
          available: () => fetch.available(),
          fetch: (request, signal) => fetch.fetch(request, signal),
        })
      }
      yield () => {
        if (provider.search !== undefined) searchProviders.delete(provider.id)
        if (provider.fetch !== undefined) fetchProviders.delete(provider.id)
      }
    }, 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * List registered provider ids and their capability kinds without secrets.
   * @param capability - optionally limit entries to providers supporting this capability.
   * @returns detached provider catalog entries sorted by provider id.
   */
  listProviders(capability?: WebProviderCapability): WebProviderInfo[] {
    const ids = new Map<string, Set<WebProviderCapability>>()
    for (const id of this.searchProviders.keys()) ids.set(id, new Set(['search']))
    for (const id of this.fetchProviders.keys()) {
      const current = ids.get(id) ?? new Set<WebProviderCapability>()
      current.add('fetch')
      ids.set(id, current)
    }
    return [...ids.entries()]
      .filter(([, capabilities]) => capability === undefined || capabilities.has(capability))
      .map(([id, capabilities]) => ({
        id,
        capabilities: [...capabilities].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam enforces `request.maxResults` on the result:
   * if the provider over-returns, `sources[]` is truncated and `truncated` set.
   * @param request - the query, optional provider id, and result limit.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's results, capped to `request.maxResults`.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const settings = this.searchSettings()
    const provider = resolveProvider({
      providers: this.searchProviders,
      ...request.provider !== undefined ? { requestedId: request.provider } : {},
      ...settings.searchProvider !== undefined ? { configuredId: settings.searchProvider } : {},
      capability: 'search',
    })
    const result = await provider.search(request, signal)
    return capSources(result, request.maxResults)
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   * @param request - the URL and optional provider id.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retrieval outcome; non-2xx responses resolve descriptively.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const settings = this.searchSettings()
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...request.provider !== undefined ? { requestedId: request.provider } : {},
      ...settings.fetchProvider !== undefined ? { configuredId: settings.fetchProvider } : {},
      capability: 'fetch',
    })
    return provider.fetch(request, signal)
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { requestedId, configuredId, providers, capability } = selection
  const selectedId = requestedId ?? configuredId
  if (selectedId !== undefined) {
    const provider = providers.get(selectedId)
    if (!provider) {
      throw new WebError(`${capability} provider "${selectedId}" is not registered; available: ${availableIds(providers) || 'none'}`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`${capability} provider "${selectedId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  throw new WebError(
    `no default ${capability} provider is configured; pass provider explicitly (available: ${availableIds(providers) || 'none'})`,
    'WEB_PROVIDER_DEFAULT_MISSING',
  )
}

/** Format provider ids for actionable selection failures. */
function availableIds<P extends ResolvableProvider>(providers: ReadonlyMap<string, P>): string {
  return [...providers.keys()].sort().join(', ')
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

export default WebRuntime
