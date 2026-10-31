# @deepseek-ai/dsh-web-deepseek-api

English | [中文](README.zh.md)

DeepSeek Search and Fetch API providers for the harness [web capability seam](../web/README.md) (`ctx.web`): one direct request per operation, without an auxiliary model request. The plugin registers `deepseek-search-api` (search) and `deepseek-fetch-api` (fetch), which share one credential and one API base; `web.searchProvider` and `web.fetchProvider` select them. It replaces the retired `dsh-web-search-deepseek`, whose Messages-based search spent a complete model turn per search.

This is an **implementation** package: it registers both providers into `ctx.web`, resolves the shared credential for each operation through the optional `ctx.credentials` seam, and does not own the `ctx.web` key or register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). It is a function/namespace plugin (`inject: ['web']`).

A mounted credentials service is authoritative; without one, the launching environment is the whole credential plane. The reference is resolved for each operation, so a key stored or rotated by the Web Models page reaches the next call without a restart.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | omitted | Literal DeepSeek API key. Prefer `apiKeyEnv` so no secret enters configuration; a non-empty literal wins. |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference resolved for each operation through `ctx.credentials`, or from the launching environment when that seam is absent. A missing value fails the call as `WEB_PROVIDER_CREDENTIAL_MISSING`. |
| `baseURL` | `https://api.deepseek.com/v1/tools` | API base including its path prefix; `/search` and `/fetch` are appended. An unparseable value makes both providers unavailable. |
| `count` | `10` | Search API results per search, 1 through 50. A smaller request `maxResults` wins and is sent for a cost/latency optimization; the seam enforces the final bound regardless. |
| `sendOriginalQuestion` | `false` | Send the triggering user question, collapsed and cut to 128 characters, as the Search API's `ori_question` to improve result ranking. Off by default: the model-authored query travels alone unless the user opts in. |

```yaml
- id: web-deepseek-api
  name: '@deepseek-ai/dsh-web-deepseek-api'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
```

The entry above is the base layer of the `web-deepseek-api` Settings section. Both providers project the complete section once per operation rather than capturing it at registration, so a committed user-layer change reaches the next operation without re-registration. `apiKey` carries `role('secret')`, so a redacted `describe()` response reports only whether that field is set and never returns its value.

## Mapping

The Search API returns a flat `results[]` and no generated answer, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← non-empty `title`, `snippet` ← non-empty `snippet`, `publishedAt` ← non-null `date`. A per-result `summary` is dropped: the seam's source vocabulary has no per-source summary field, and inventing one would make the seam lie. The Fetch API returns page Markdown: a success is the requested page retrieved with HTTP 200 semantics — the API reports neither the target's status nor a final URL, and it fails when the target yields no usable content, so the result carries `{ kind: 'text', content }` and `truncated: false`.

Provider and credential-resolution failures surface as `WEB_PROVIDER_ERROR` with the dispatched endpoint and the settings recovery guidance appended, a missing credential as `WEB_PROVIDER_CREDENTIAL_MISSING` naming the plugin, and caller cancellation as `WEB_ABORTED`. Cancellation before or during credential preflight dispatches no HTTP request. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's bounded URLs, titles, snippets, and publication dates or its actionable endpoint-guidance and missing-credential failures under the consumer's error wrapper while provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Per-result `summary` values are dropped** — the seam's `WebSearchSource` has no summary field; adding one is a coordinated Service Definition change, not a provider concern.
- **`fetch()` reports HTTP 200 for every success** — the Fetch API does not expose the target's status or final URL after redirects.
- **Dynamic credential availability resolves inside the operation** — synchronous `available()` can establish that a resolver exists but cannot query an asynchronous credential store. A selected keyless provider therefore fails the operation with `WEB_PROVIDER_CREDENTIAL_MISSING`.
