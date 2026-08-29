# @deepseek-ai/dsh-web-search-kagi

English | [中文](README.zh.md)

A [Kagi](https://kagi.com) backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls `GET https://kagi.com/api/v1/search?q=...` with native `fetch` and registers as provider id `kagi`.

This is an implementation package and a function/namespace plugin with `inject: ['web']`. It registers into the aggregate web service, does not add a tool, and does not use the LLM seam. A mounted credentials service is authoritative; the launching environment is consulted only when that seam is absent. Kagi's credential reference is resolved for each search.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Kagi API token. Prefer `apiKeyEnv`; a non-empty literal is used directly. |
| `apiKeyEnv` | `KAGI_API_KEY` | Credential reference resolved per search, or launch-environment fallback without the credentials seam. |
| `baseURL` | `https://kagi.com/api/v1` | Kagi API base; `/search` is appended. |

```yaml
- id: web-search-kagi
  name: '@deepseek-ai/dsh-web-search-kagi'
  config:
    apiKeyEnv: KAGI_API_KEY
```

`apiKey` has `role('secret')` and is absent from redacted settings descriptions. The token is sent as `Authorization: Bot <token>`. Every credential-bearing request uses `redirect: 'error'`, rejecting redirects before a target is contacted.

## Mapping

Kagi receives only the model query as `q`; the aggregate web seam owns the final `maxResults` bound. The adapter accepts the documented direct result array and common `data`, `results`, or `items` wrappers. Each result maps `url` to `url`, `title` to `title`, `snippet` to `snippet`, and `published` to `publishedAt`. Kagi does not provide an AI answer through this adapter, so `content` is omitted.

Missing credentials surface as `WEB_PROVIDER_CREDENTIAL_MISSING`, provider/network/HTTP/body failures as `WEB_PROVIDER_ERROR`, and caller cancellation as `WEB_ABORTED`. Cancellation before credential resolution or dispatch sends no HTTP request.

## Model Experience

### Search result sources

#### What the model sees

Through [`dsh-tool-web`](../tool-web/README.md), the model receives normalized, `maxResults`-bounded source URLs, titles, snippets, and publication dates. The Kagi token, wrapper metadata, and other provider-private fields remain hidden.

#### Token effect

This provider makes no additional model inference request; only the selected conversation model consumes the normalized search result context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- Kagi's provider-specific filters, result types, and ranking metadata are not exposed by the current provider-neutral seam.
- The adapter tolerates wrapper shapes but intentionally ignores non-result metadata and malformed entries without a usable URL.
- Dynamic credential availability is confirmed inside the operation because `available()` cannot synchronously query an asynchronous credentials store.
