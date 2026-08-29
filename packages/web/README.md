# web/ — web capability family

English | [中文](README.zh.md)

This family provides provider-neutral web search and fetch operations plus the model-facing tools that consume them. Providers may implement one or both operations, while the model chooses a registered provider explicitly or uses the configured default for that operation.

| Package | Role | ctx key |
|---|---|---|
| [`web/`](web/README.md) | Defines web provider registration, selection, and shared errors | `ctx.web` |
| [`web-search-exa/`](web-search-exa/README.md) | Provides web search through Exa | registers on `ctx.web` |
| [`web-search-perplexity/`](web-search-perplexity/README.md) | Provides web search through Perplexity | registers on `ctx.web` |
| [`web-search-deepseek/`](web-search-deepseek/README.md) | Provides native DeepSeek web search | registers on `ctx.web` |
| [`web-search-tavily/`](web-search-tavily/README.md) | Provides web search through Tavily | registers on `ctx.web` |
| [`web-search-brave/`](web-search-brave/README.md) | Provides web search through Brave | registers on `ctx.web` |
| [`web-search-kagi/`](web-search-kagi/README.md) | Provides web search through Kagi | registers on `ctx.web` |
| [`web-firecrawl/`](web-firecrawl/README.md) | Provides Firecrawl Search and Scrape | registers on `ctx.web` |
| [`web-fetch-http/`](web-fetch-http/README.md) | Fetches public HTTP and HTTPS resources | registers on `ctx.web` |
| [`tool-web/`](tool-web/README.md) | Exposes web search and fetch to the model | registers on `ctx.tools` |

The [web capability decision](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) records why search and fetch share one provider-selection service.

The subsystem reference — search/fetch requests and results, availability, `WebError` — is [docs/subsystems/web.md](../../docs/subsystems/web.md); rationale (including deferred SSRF protection) in the [web capability seam Agent Note](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md).
