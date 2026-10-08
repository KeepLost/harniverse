# @deepseek-ai/dsh-web-search-cloudflare

English | [中文](README.zh.md)

A [Cloudflare Web Search API](https://developers.cloudflare.com/web-search/) backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls `POST {baseURL}/accounts/{accountId}/ai/websearch/` with native `fetch` and registers as provider id `cloudflare`. Cloudflare routes the query through one of your AI Gateways to an upstream engine (Ceramic.ai, Exa, or Linkup) and bills it to AI Gateway credits, or to the engine directly when a stored provider key is used (bring your own key).

This is an implementation package and a function/namespace plugin with `inject: ['web']`. It registers into the aggregate web service, does not add a tool, and does not use the LLM seam. A mounted credentials service is authoritative; the launching environment is consulted only when that seam is absent. The token reference is resolved for each search, so a token stored or rotated by the Web Models page reaches the next call without a restart.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Cloudflare API token. Prefer `apiKeyEnv`; a non-empty literal is used directly. |
| `apiKeyEnv` | `CLOUDFLARE_API_TOKEN` | Credential reference resolved per search, or launch-environment fallback without the credentials seam. A missing value fails the call as `WEB_PROVIDER_CREDENTIAL_MISSING`. |
| `accountId` | omitted | Cloudflare account id, required before the first search. A blank or malformed value (anything but 1 to 64 letters, digits, `_`, `-`) fails the call as `WEB_PROVIDER_CONFIG_INVALID` before any credential or network work. |
| `gatewayId` | `default` | AI Gateway the request is routed through. Every account has a gateway named `default`. A blank value makes the provider unavailable. |
| `engine` | `ceramic` | Upstream engine sent as Cloudflare's `provider` field: `ceramic`, `exa`, or `linkup`. |
| `byokAlias` | omitted | Alias of an engine key stored on the gateway. When set, Cloudflare fails the request instead of falling back to credits if the alias is not configured. Must match 1 to 64 letters, digits, `_`, `-`, otherwise the provider is unavailable. |
| `baseURL` | `https://api.cloudflare.com/client/v4` | Cloudflare API base. An unparseable value makes the provider unavailable. |
| `snippetMaxChars` | `2000` | Longest description kept per result. Must be a positive integer. |

```yaml
- id: web-search-cloudflare
  name: '@deepseek-ai/dsh-web-search-cloudflare'
  config:
    accountId: 0123456789abcdef0123456789abcdef
    apiKeyEnv: CLOUDFLARE_API_TOKEN
```

The API token needs **Account > Workers AI > Read** and **Account > AI Gateway > Read**. `apiKey` has `role('secret')` and is absent from redacted settings descriptions. The token is sent as `Authorization: Bearer <token>`. Every credential-bearing request uses `redirect: 'error'`, rejecting redirects before a target is contacted.

## Mapping

The request body carries the model query as `query`, the configured `engine` as `provider`, `options.gateway.id`, an optional `byokAlias`, and a `limit` only when the request has a `maxResults` (capped at Cloudflare's ceiling of 10). The aggregate web seam enforces the final `maxResults` bound.

Cloudflare answers with `{ items, metadata }` and no generated answer, so `content` is omitted. Each item maps `url` to `url`, `title` to `title`, and `description` to `snippet`, cut to `snippetMaxChars` without splitting a surrogate pair. An item without a usable `url` is dropped, and a malformed envelope yields no sources rather than an error. `imageUrl`, `faviconUrl`, and `lastModifiedDate` are not mapped: the portable shape has no field for them, and a last-modified time is not a publication date.

Missing credentials surface as `WEB_PROVIDER_CREDENTIAL_MISSING`, an unusable account id as `WEB_PROVIDER_CONFIG_INVALID`, provider/network/HTTP/body failures as `WEB_PROVIDER_ERROR`, and caller cancellation as `WEB_ABORTED`. Cloudflare reports HTTP failures in four envelopes (`errors[]`, `error[]`, a bare `message`, and `error.code`); the first usable detail becomes `Cloudflare web search failed: <detail>`, and a body with none becomes `Cloudflare API error (HTTP <status>)`. Cancellation before credential resolution or dispatch sends no HTTP request.

## Model Experience

### Search result sources

#### What the model sees

Through [`dsh-tool-web`](../tool-web/README.md), the model receives normalized, `maxResults`-bounded source URLs, titles, and snippets cut to `snippetMaxChars`; there is no publication date. The Cloudflare token, account id, gateway id, request metadata, and other provider-private fields remain hidden. Failures reach the model as exactly `Cloudflare search credential resolution failed: <error>`, `Cloudflare search request failed: <error>`, `Cloudflare returned an unprocessable response body: <error>`, `Cloudflare search aborted`, the account-id and token guidance messages, or the HTTP error messages above, under the consumer's error wrapper.

#### Token effect

This provider makes no additional model inference request. Each snippet can be up to `snippetMaxChars` characters, which is the main lever on how much context a search consumes: Ceramic.ai alone can return up to 8,000 characters per result.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Cloudflare's Web Search API is in beta** — the request and response shapes were checked against the live API on 2026-10-09, but its limits (1,024-character queries, 10 results) and pricing may change.
- **A query over 1,024 characters is rejected by Cloudflare** — it surfaces as the generic `Cloudflare web search failed: Invalid web search request body`; the adapter does not truncate or pre-validate model queries.
- **Engine-specific controls are not exposed** — Cloudflare offers none beyond `provider` and `limit`, and the current provider-neutral seam has no field for filters or freshness.
- **Dynamic credential availability resolves inside the operation** — synchronous `available()` can establish that a resolver exists but cannot query an asynchronous credential store, so a selected tokenless provider fails the search with `WEB_PROVIDER_CREDENTIAL_MISSING`. The account id is likewise checked at search time to give an actionable message instead of a generic "unavailable" error.
