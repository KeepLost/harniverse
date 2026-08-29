# @deepseek-ai/dsh-web-firecrawl

English | [中文](README.zh.md)

A [Firecrawl](https://www.firecrawl.dev) aggregate provider for the harness [web capability seam](../web/README.md) (`ctx.web`). It registers one provider id, `firecrawl`, with both Search (`POST /v2/search`) and markdown Scrape (`POST /v2/scrape`) capabilities. It uses native `fetch`, not a vendor SDK.

This is a function/namespace plugin with `inject: ['web']`. It contributes to `ctx.web`, does not replace the aggregate service, and does not add AI answer, crawl, or extract tools. A mounted credentials service is authoritative. Only when that seam is absent does the provider read the launching environment. The Firecrawl credential reference is resolved independently for every search and fetch operation; the basic Firecrawl API also permits anonymous requests, so an absent key is allowed.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Optional literal Firecrawl API key. Prefer `apiKeyEnv`; a non-empty literal is used directly. |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | Credential reference resolved for every operation, or launch-environment fallback without the credentials seam. |
| `baseURL` | `https://api.firecrawl.dev` | API base; `/v2/search` and `/v2/scrape` are appended. |
| `includeSearchContent` | `false` | When true, Search requests `scrapeOptions.formats: ['markdown']` and maps bounded per-result content into `snippet`. |
| `searchContentMaxChars` | `10000` | Maximum characters of optional Search markdown/raw content included in each `snippet`. |
| `maxChars` | `100000` | Maximum characters returned from a Scrape markdown body. |

```yaml
- id: web-firecrawl
  name: '@deepseek-ai/dsh-web-firecrawl'
  config:
    apiKeyEnv: FIRECRAWL_API_KEY
    includeSearchContent: false
```

`apiKey` has `role('secret')`. When a key is configured, Search and Scrape send `Authorization: Bearer <key>` and `redirect: 'error'`; anonymous requests omit the authorization header. No request follows a redirect.

## Mapping

Search sends `query` and an optional `limit` from the operation's `maxResults`. It never requests an AI answer. Firecrawl Search responses in `{results: []}`, `{success, data: []}`, or the v2 `{success, data: {web: []}}` form map `url`, `title`, and `description` to the portable source fields. When enabled, `markdown` or `content` is appended to the source `snippet` and capped by `searchContentMaxChars`; the current seam is not expanded with a vendor-specific source content field.

Scrape sends `{url, formats: ['markdown']}` and maps returned `markdown` (falling back to `content`) to a `text` `WebFetchBody`. `metadata.url` is preferred as the final result URL, with `metadata.sourceURL` and the requested URL as fallbacks; `metadata.statusCode` becomes the target status when present. `maxChars` caps the body and sets `truncated`. A target body is preserved even when Firecrawl's API response itself is non-2xx. A non-2xx API response with no target body, or a successful response with no target body, is a `WEB_PROVIDER_ERROR`.

Credential resolution, provider, network, HTTP, and body failures surface as `WEB_PROVIDER_ERROR`; caller cancellation surfaces as `WEB_ABORTED`. An absent key is allowed for Firecrawl's anonymous API path.

## Model Experience

### Search result sources

#### What the model sees

Through [`dsh-tool-web`](../tool-web/README.md), the model receives portable Firecrawl source URLs, titles, and snippets, including optional search markdown capped by `searchContentMaxChars`; the consumer owns the final `maxResults` bound.

#### Token effect

This provider makes no additional model inference request; search content and source metadata consume only the selected conversation model's normalized tool-result context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

### Markdown fetch result

#### What the model sees

The model receives the `maxChars`-bounded markdown body as a text fetch result through [`dsh-tool-web`](../tool-web/README.md). The Firecrawl key, target transport metadata, and API wrapper remain hidden.

#### Token effect

Only the selected conversation model's context tokens are affected by the returned markdown; this provider makes no model inference request.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- Search content uses the existing `snippet` field because the current web seam has no source-level content field; larger or structured content waits on a provider-neutral contract.
- Firecrawl Search result counts and Scrape body bounds are provider-side optimizations plus consumer-visible caps; the aggregate seam still owns `maxResults` source truncation.
- Target status and URL depend on Firecrawl metadata. When absent, the adapter uses the requested URL and the API response status as the available fallback.
