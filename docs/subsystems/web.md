# Web Access

English | [中文](web.zh.md)

The web access seam — a [capability seam](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) that spans **two operations** (search and fetch) on one `ctx.web` service, split across packages: Service Definition ([dsh-web](../../packages/web/web), `ctx.web` + the provider registries), Service Providers ([dsh-web-search-exa](../../packages/web/web-search-exa), [dsh-web-search-perplexity](../../packages/web/web-search-perplexity), [dsh-web-search-deepseek](../../packages/web/web-search-deepseek), [dsh-web-search-tavily](../../packages/web/web-search-tavily), [dsh-web-search-brave](../../packages/web/web-search-brave), [dsh-web-search-kagi](../../packages/web/web-search-kagi), [dsh-web-firecrawl](../../packages/web/web-firecrawl), [dsh-web-fetch-http](../../packages/web/web-fetch-http)), and Consumer ([dsh-tool-web](../../packages/web/tool-web), the `web_search`/`web_fetch` tool schemas). Web is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A search-provider swap does not change the model's required `queries` array, and a fetch-provider swap does not change how the model asks for a URL.

Source: [`packages/web/web/src/types.ts`](../../packages/web/web/src/types.ts)

## Why one capability has two operations

Search and fetch share no request schema and no business logic, but they are deliberately one `ctx.web` middle layer: one provider-selection policy owner, one abort/error vocabulary, and one product-facing "how this harness reaches the web" configuration API. The cost is the parallel `searchX`/`fetchX` method pairs on the service; that parallelism is intentional, not a missed extraction. Providers register one aggregate `WebProvider` with optional capabilities, not tools; the model-facing names, schemas, prompt guidance, and presentation all live in the single `dsh-tool-web` consumer.

## Search request and result

The provider seam receives one scalar `query`; the model-facing `dsh-tool-web` consumer requires a nonempty `queries` array bounded by `searchMaxQueries` (default `4`). The consumer removes exact duplicate query strings after validating the bound, fans distinct queries out concurrently, and passes each one separately through `ctx.web.search()`. `maxResults` remains a consumer-owned source bound (`searchMaxResults`, default `8`) passed through the seam and enforced on the way back — if a provider over-returns, the seam truncates `sources[]` and sets `truncated`.

### Batched model search

The tool rejects missing, empty, non-string, blank, mixed legacy `{ query }`, and over-limit inputs before provider execution. A sibling failure aborts the shared batch signal, waits for every started search to settle, and then returns the first failure; caller cancellation follows the same path. Successful sources are deduplicated by exact URL and merged in query-order round-robin rank until `searchMaxResults`. Non-empty provider answers are emitted in query order under `### <query>` headings. A one-item array still uses the provider's direct result, while the provider API remains single-query.

```ts type-equiv
/**
 * What one search-capable backend can return. `provider` selects the backend
 * through the WebRuntime; `maxResults` is a `dsh-tool-web`-layer bound passed
 * through unchanged and enforced on the way back by the seam (see
 * {@link WebSearchResult}).
 */
interface WebSearchRequest {
  readonly query: string
  /** Optional provider id; omitted means use the WebRuntime search default. */
  readonly provider?: string
  /**
   * Upper bound on returned sources; the seam truncates to it. Omitted = no
   * bound. `dsh-tool-web` always sets it. A provider whose API supports a
   * result-count control (Exa's `numResults`) should apply it at the request
   * layer as a cost/latency optimization; the seam enforces the bound
   * regardless.
   */
  readonly maxResults?: number
}
```

```ts type-equiv
/**
 * Normalized search outcome. `content` is optional provider-generated answer
 * text or summary (Exa and DeepSeek return none; Perplexity returns a
 * generated answer).
 * `sources[]` is the portable citation shape. `truncated` is set by the seam
 * when it cut `sources[]` down to `maxResults`.
 */
interface WebSearchResult {
  /** Optional provider-generated answer text, search context, or summary. */
  readonly content?: string
  /** Citeable sources, already truncated to the request's `maxResults`. */
  readonly sources: readonly WebSearchSource[]
  /** True when the seam dropped sources to honor `maxResults`. */
  readonly truncated: boolean
}
```

```ts type-equiv
/**
 * One citeable source. A source always has a URL; `title`, `snippet`, and
 * `publishedAt` are optional because not every provider returns them — forcing
 * adapters to invent them would make the seam lie (Perplexity citations may be
 * URL-only). `dsh-tool-web` renders `title ?? hostname(url)` for display.
 */
interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  /** Publication/crawl timestamp as a provider-supplied ISO-8601 string. */
  readonly publishedAt?: string
}
```

## Fetch request and result

```ts type-equiv
/**
 * What one fetch-capable backend is asked to retrieve. `provider` selects the
 * backend through the WebRuntime. The request deliberately omits timeout,
 * format, prompt, and extraction controls: cancellation is a direct execution
 * argument, while presentation and higher-level LLM concerns belong outside
 * safe retrieval.
 */
interface WebFetchRequest {
  readonly url: string
  /** Optional provider id; omitted means use the WebRuntime fetch default. */
  readonly provider?: string
}
```

HTTP status is part of the fetched resource state, not automatically a failure: a successful network fetch of a `404`/`500` returns a `WebFetchResult` with the status code and a bounded decoded body. `url` is the final URL after allowed redirects. `WebError` is reserved for failures to safely retrieve or represent the resource.

```ts type-equiv
/**
 * Normalized fetch outcome. A successful network fetch of a non-2xx response is
 * a result, not an error: the status code is part of the fetched resource
 * state. {@link WebError} is reserved for failures to safely retrieve or
 * represent the resource.
 */
interface WebFetchResult {
  /** The final URL after allowed redirects (the request URL is in the request). */
  readonly url: string
  /** HTTP status code of the fetched response. */
  readonly statusCode: number
  /** Decoded body, classified by content kind. */
  readonly body: WebFetchBody
  /** True when the provider capped the decoded body. */
  readonly truncated: boolean
}
```

```ts type-equiv
/**
 * The decoded body of a fetched resource. A CLOSED discriminated union owned by
 * `dsh-web`: the provider decodes the kind and `dsh-tool-web` renders it, so a
 * new kind is a coordinated change across known packages, not a plugin
 * extension. Consumers `switch` on `kind` ending in `default: assertNever(...)`
 * so adding a kind breaks compilation at every consumer until handled. Each arm
 * stays its own object literal even where fields coincide, so an arm can gain
 * fields the others lack.
 */
type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }
```

```ts type-equiv
/** Capability names exposed by one aggregate Web provider. */
type WebProviderCapability = 'search' | 'fetch'
```

```ts type-equiv
/** One provider's optional Web capabilities, registered as one lifecycle unit. */
interface WebProvider {
  /** Stable provider id, unique within each capability it implements. */
  readonly id: string
  /** Search implementation, when this provider supports search. */
  readonly search?: Omit<WebSearchProvider, 'id'>
  /** Fetch implementation, when this provider supports fetch. */
  readonly fetch?: Omit<WebFetchProvider, 'id'>
}
```

```ts type-equiv
/** Non-secret provider catalog entry exposed to discovery surfaces. */
interface WebProviderInfo {
  readonly id: string
  readonly capabilities: readonly WebProviderCapability[]
}
```

## Provider availability

A provider's `available(): boolean` is a cheap LOCAL check (credential source, parseable config) and **must not make network calls**. It is an input to execution-time selection, not a health system: `search()`/`fetch()` read it for the explicitly selected provider, and a selection failure surfaces as the structured `WebError` the caller routes on.

Selection never depends on registration, config, or HMR order: an operation's explicit `provider` id wins over the configured `searchProvider`/`fetchProvider` default. Without either id, the operation fails with `WEB_PROVIDER_DEFAULT_MISSING`; the runtime never auto-selects or falls back to another provider.

## Errors

`WebError extends HarnessError` ([core.md](core.md) error taxonomy) with a `code: string` (open, like every other seam's error — `LlmError`, `SubagentError`), not a closed union: a provider may raise its own codes without editing `dsh-web`, and consumers must tolerate an unknown code. The codes split by owner. Seam-neutral codes are raised by the shared `WebRuntime` contract: `WEB_PROVIDER_DEFAULT_MISSING`, `WEB_PROVIDER_CONFIGURED_MISSING`, `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`, `WEB_PROVIDER_INVALID`, `WEB_DUPLICATE_PROVIDER` (a registration-time programming error, the analogue of `LlmRuntime`'s `DUPLICATE_ADAPTER`), `WEB_ABORTED`, and `WEB_PROVIDER_ERROR` (the catch-all for a provider's own failure surfaced through the seam, including network/transport failure — DNS, connection refused, TLS). Fetch-transport codes are owned by the `dsh-web-fetch-http` implementation and a different fetch backend need not raise them: `WEB_INVALID_URL`, `WEB_BLOCKED_URL`, `WEB_REDIRECT_BLOCKED`, `WEB_FETCH_TOO_LARGE`, `WEB_FETCH_TIMEOUT`, `WEB_UNSUPPORTED_CONTENT_TYPE`.

## The service

`WebRuntime` registers search and fetch providers, rejects duplicate ids with `WEB_DUPLICATE_PROVIDER`, and resolves providers at execution time with structured selection errors. The local fetch backend accepts only HTTP(S), rejects credentials, caps redirects, bytes, characters, and time, revalidates every same-origin redirect hop, and decodes the body; the tool owns presentation. The local backend does not block private-network targets; do not enable `web_fetch` where it can reach sensitive internal ones.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxweb--webruntime"></a>

### `ctx.web` — `WebRuntime`

The web access service. Registered as `ctx.web` (one instance per context).

Selection semantics (resolved at execution time, never order-dependent):

- A configured id that is registered and `available()` → that provider.
- A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No operation or configured id → `WEB_PROVIDER_DEFAULT_MISSING`.

```ts cordis-catalog
/**
 * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
 * if its id is already registered for search. Returns a disposer; disposed
 * with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerSearchProvider(provider: WebSearchProvider): () => void

/**
 * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
 * if its id is already registered for fetch. Returns a disposer; disposed
 * with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerFetchProvider(provider: WebFetchProvider): () => void

/**
 * Register one provider's available capabilities as one lifecycle unit.
 * @param provider - the aggregate provider and its optional capabilities.
 * @returns the disposer that unregisters every capability contributed by the provider.
 */
registerProvider(provider: WebProvider): () => void

/**
 * List registered provider ids and their capability kinds without secrets.
 * @param capability - optionally limit entries to providers supporting this capability.
 * @returns detached provider catalog entries sorted by provider id.
 */
listProviders(capability?: WebProviderCapability): WebProviderInfo[]

/**
 * Run one search through the selected provider. Resolves the provider at call
 * time with the selection rules above; throws {@link WebError} when the
 * capability cannot run. The seam enforces `request.maxResults` on the result:
 * if the provider over-returns, `sources[]` is truncated and `truncated` set.
 * @param request - the query, optional provider id, and result limit.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the provider's results, capped to `request.maxResults`.
 */
async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>

/**
 * Retrieve one URL through the selected provider. Resolves the provider at
 * call time with the selection rules above; throws {@link WebError} when the
 * capability cannot run. A non-2xx response is a result, not a throw.
 * @param request - the URL and optional provider id.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the retrieval outcome; non-2xx responses resolve descriptively.
 */
async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
```

Source: [`packages/web/web/src/index.ts:99`](../../packages/web/web/src/index.ts)
<!-- END GENERATED cordis-surface -->
