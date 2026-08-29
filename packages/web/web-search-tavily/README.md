# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

A [Tavily](https://tavily.com) backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls `POST https://api.tavily.com/search` with native `fetch` and maps Tavily's flat `results[]` into `WebSearchResult`.

This is an implementation package. It is a function/namespace plugin with `inject: ['web']`; it registers the `tavily` provider into `ctx.web`, does not own the web service, and does not add a model-facing tool. A mounted credentials service is authoritative. Without that optional seam, the configured credential reference is read from the launching environment. The reference is resolved for every search, so rotation takes effect without a restart.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal Tavily key. Prefer `apiKeyEnv`; a non-empty literal is used directly. |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference resolved for each search, or launch-environment fallback when no credentials seam exists. |
| `baseURL` | `https://api.tavily.com` | API base; `/search` is appended. |
| `includeRawContent` | `false` | Sends Tavily `include_raw_content: true` when enabled. |
| `maxResults` | unset | Default Tavily `max_results` when the operation omits `maxResults`; the operation value wins. |

```yaml
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

`apiKey` has `role('secret')`; redacted settings descriptions report only whether it is set. Every credential-bearing request uses `redirect: 'error'`, so an HTTP redirect is rejected before its `Location` target is contacted.

## Mapping

The request contains `query` and `include_answer: false`. `max_results` is sent only when an operation or configuration supplies it. `include_raw_content` is sent only when enabled. Each source maps `url` to `url`, `title` to `title`, `content` (or `raw_content` when normal content is absent) to `snippet`, and `published_date` to `publishedAt`. Tavily's score is provider-specific and is not exposed by the web seam. No generated answer is returned.

Missing credentials surface as `WEB_PROVIDER_CREDENTIAL_MISSING`, provider/network/HTTP/body failures as `WEB_PROVIDER_ERROR`, and caller cancellation as `WEB_ABORTED`. Cancellation before credential resolution or dispatch makes no HTTP request.

## Model Experience

### Search result sources

#### What the model sees

Through [`dsh-tool-web`](../tool-web/README.md), the model receives source URLs, titles, snippets, and publication dates after the consumer applies its `maxResults` bound. Tavily keys, scores, and transport fields remain hidden.

#### Token effect

This provider makes no additional model inference request; only the selected conversation model consumes the normalized search result context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- Tavily's score and other vendor-specific search controls are not exposed because the current web seam has no provider-neutral fields for them.
- Optional raw content is mapped into the existing `snippet` field; `WebSearchSource` is not expanded with a vendor-specific content field.
- Dynamic credential availability is checked inside the operation because `available()` cannot synchronously query an asynchronous credentials store.
