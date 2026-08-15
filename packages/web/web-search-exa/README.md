# @deepseek-ai/dsh-web-search-exa

English | [中文](README.zh.md)

An [Exa](https://exa.ai)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Exa's `POST /search` endpoint with highlight contents and maps the flat `results[]` into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, resolves its credential for each search through the optional `ctx.credentials` seam, and does not own the `ctx.web` key or register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

A mounted credentials service is authoritative; without one, the provider falls back to the launching environment. The reference is resolved for each search, so a key stored or rotated by the Web Models page reaches the next call without a restart.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Exa API key. Prefer `apiKeyEnv` so no secret enters configuration; a non-empty literal wins. |
| `apiKeyEnv` | `EXA_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the launching environment when that seam is absent. A missing value fails the call as `WEB_PROVIDER_CREDENTIAL_MISSING`. |
| `baseURL` | `https://api.exa.ai` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable. |
| `searchType` | `auto` | Retrieval mode sent as Exa's `type`: `auto` (Exa decides), `keyword`, or `neural`. |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`. Unset sends no default. Must be a positive integer. |
| `highlightsPerResult` | `1` | Highlight sentences requested per result (Exa's `highlightsPerUrl`). Must be a positive integer. |

```yaml
- id: web-search-exa
  name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKeyEnv: EXA_API_KEY
```

The entry above is the base layer of the `web-search-exa` Settings section. A user layer over it reaches the next search because the provider snapshots the complete section once per call rather than capturing it at registration. `apiKey` carries `role('secret')`, so a redacted `describe()` response reports only whether that field is set and never returns its value.

## Mapping

Exa returns a flat `results[]` and no generated answer, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← the first non-empty `highlights[]` entry (a result with no highlight has no portable snippet and is dropped), `publishedAt` ← `publishedDate`. A request's `maxResults` wins over the configured `numResults` default and is sent as Exa's `numResults` for a cost/latency optimization; the final bound is enforced by the seam. Provider and credential-resolution failures surface as `WEB_PROVIDER_ERROR`, a missing credential as `WEB_PROVIDER_CREDENTIAL_MISSING`, and caller cancellation as `WEB_ABORTED`. Cancellation before or during credential preflight dispatches no HTTP request. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, first highlights, and publication dates or its actionable missing-credential message and exact `Exa search credential resolution failed: <error>`, `Exa search aborted`, `Exa search request failed: <error>`, and `Exa returned an unprocessable response body: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **A result with no non-blank highlight is dropped entirely** — no portable snippet to map, so fewer sources than the requested count can return.
- **Only `searchType`/`numResults`/`highlightsPerResult` are exposed** — Exa's other controls (livecrawl, category, domain/date filters, full-text contents) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Dynamic credential availability resolves inside the operation** — synchronous `available()` can establish that a resolver exists but cannot query an asynchronous credential store. A selected keyless provider therefore fails the search with `WEB_PROVIDER_CREDENTIAL_MISSING`; caller cancellation races this preflight locally but cannot force an arbitrary credential backend itself to stop work.
