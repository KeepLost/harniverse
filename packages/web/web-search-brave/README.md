# @deepseek-ai/dsh-web-search-brave

English | [中文](README.zh.md)

A [Brave Search](https://brave.com/search/api/) backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Brave's web search endpoint with native `fetch` and registers as provider id `brave`.

This is a function/namespace plugin with `inject: ['web']`. It contributes a provider to `ctx.web`; it does not own the aggregate service or add a model-facing tool. A mounted credentials service is authoritative. Only when that seam is absent does the provider use the launching environment. The credential reference is resolved for each search.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Brave subscription token. Prefer `apiKeyEnv`; a non-empty literal is used directly. |
| `apiKeyEnv` | `BRAVE_API_KEY` | Credential reference resolved for every search, or launch-environment fallback without the credentials seam. |
| `baseURL` | `https://api.search.brave.com/res/v1/web` | Brave web endpoint base; `/search` is appended. |
| `maxResults` | unset | Default Brave `count` when an operation omits `maxResults`; the operation value wins. |

```yaml
- id: web-search-brave
  name: '@deepseek-ai/dsh-web-search-brave'
  config:
    apiKeyEnv: BRAVE_API_KEY
```

`apiKey` is a `role('secret')` setting. Every request carrying the subscription token uses `redirect: 'error'`; redirect targets are never contacted.

## Mapping

The request is `GET /search?q=...` with optional `count`, `X-Subscription-Token`, and `Accept: application/json`. Brave's `web.results[]` entries map `url` to `url`, `title` to `title`, and `description` followed by non-blank `extra_snippets` to one `snippet`. The current seam has no score or answer field, so neither is invented.

Missing credentials surface as `WEB_PROVIDER_CREDENTIAL_MISSING`; HTTP, network, and unprocessable response failures surface as `WEB_PROVIDER_ERROR`; cancellation surfaces as `WEB_ABORTED`. Cancellation before dispatch sends no request.

## Model Experience

### Search result sources

#### What the model sees

Through [`dsh-tool-web`](../tool-web/README.md), the model receives the portable source URLs, titles, and combined snippets after the consumer applies its `maxResults` bound. The Brave token and provider-private request fields stay hidden.

#### Token effect

This provider makes no additional model inference request; token use is limited to the selected conversation model consuming the normalized search result context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- Brave filters, freshness controls, and result metadata beyond the portable source fields remain provider-private until the web seam grows neutral fields.
- Primary and extra descriptions are combined in `snippet`; no vendor-specific source content field is added.
- `available()` can confirm that a resolver exists but cannot synchronously prove that an asynchronous credentials store currently contains a token.
