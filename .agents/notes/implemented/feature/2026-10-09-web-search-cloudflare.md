# Agent Note: Add Cloudflare as a Web search provider

Status: implemented

English | [中文](2026-10-09-web-search-cloudflare.zh.md)

## Problem

Cloudflare launched a Web Search API on 2026-10-02: `POST /accounts/{accountId}/ai/websearch/` routes a query through one of the account's AI Gateways to Ceramic.ai, Exa, or Linkup and bills it to AI Gateway credits, or to the engine directly when the gateway stores that engine's key (bring your own key). A user with a Cloudflare account and an API token could not use it from `web_search`: the harness had providers for DeepSeek, Exa, Perplexity, Tavily, Brave, Kagi, and Firecrawl only.

Cloudflare does not follow the shape the other providers share. The endpoint needs an account id in the path and a gateway id in the body; the engine is a request field; the success envelope is `{ items, metadata }` with `description` instead of a snippet; and failures arrive in four envelopes (`errors[]`, `error[]`, a bare `message`, `error: { code }`). Its descriptions run to 8,000 characters (Ceramic.ai) with no bound the seam or `dsh-tool-web` applies.

## Decision

A new plugin package `@deepseek-ai/dsh-web-search-cloudflare` registers provider id `cloudflare` into `ctx.web` and owns the `web-search-cloudflare` settings section, exactly as `web-search-kagi` does: function plugin, `inject: ['web']`, credential resolved per search through `ctx.credentials` (launch environment when that seam is absent), `redirect: 'error'` on every credential-bearing request. It is mounted in the base bundle, so it appears in the Web search card and in the `web_search` provider list without further composition.

The section carries `apiKey` (secret), `apiKeyEnv` (default `CLOUDFLARE_API_TOKEN`), `accountId`, `gatewayId` (default `default`), `engine` (`ceramic` default, `exa`, `linkup`), `byokAlias`, `baseURL`, and `snippetMaxChars` (default 2,000). The upstream engine is named `engine`, not `provider`, because `provider` already means a harness `ctx.web` provider.

The account id is checked when the search runs, not in `available()`. A blank or malformed id fails with `WEB_PROVIDER_CONFIG_INVALID` and an instruction to set `accountId`, before any credential lookup or request. Making `available()` false would have produced only "registered but unavailable", which does not say what to fix; a missing token is reported the same way, from inside the operation. The id is restricted to 1 to 64 letters, digits, `_`, `-`, which also keeps it safe inside the URL path.

`description` maps to the snippet and is cut to `snippetMaxChars`, backing off one unit when the cut would split a surrogate pair. Without that bound, eight Ceramic.ai results could put 64,000 characters in front of the model per query. `lastModifiedDate` (Exa only) is not mapped to `publishedAt`: it is a modification time, and the portable shape documents `publishedAt` as publication or crawl time. `limit` is sent only when the request has a `maxResults`, capped at Cloudflare's ceiling of 10, because Cloudflare rejects larger values with HTTP 400.

HTTP failures take the first usable message from `errors[]`, `error[]`, `message`, or `error.code`, in that order, and read `Cloudflare web search failed: <detail>`; a body with none reads `Cloudflare API error (HTTP <status>)`.

The settings page gains a Cloudflare entry in the provider selector with fields for the token, account id, gateway id, engine, key alias, endpoint, and snippet length. `web-search-cloudflare` joins the namespaces the API proxy serves and the remote-runtime snapshot syncs, so the section is readable, writable, and carried to SSH hosts like the other provider sections.

The request and response shapes, all four error envelopes, and the 400 on `limit` above 10 were observed against the live API on 2026-10-09 with an account token before the tests were written; the tests use those shapes.

## Alternatives considered

**Search through the `/ai/run` inference endpoint (the other sample in the request).** Rejected: it runs a model through AI Gateway and returns generated text, not sources, so it cannot fill the `WebSearchResult.sources` contract. The Workers `env.AI.websearch()` binding is not an option either, since the harness runs outside Workers; the REST endpoint is the documented path for that case.

**Expose Cloudflare's three engines as three providers (`cloudflare-exa`, …).** Rejected: the engine is a parameter of one account, gateway, and token, so one provider with an `engine` setting keeps one credential and one settings section. The model sees one `cloudflare` id and the user picks the engine in settings.

**Read the account id from `CLOUDFLARE_ACCOUNT_ID`.** Rejected for now: the settings page is the primary configuration path and an account id is not a secret, so a second resolution rule would add branches and a precedence to document for a convenience nobody has asked for.

**Pass descriptions through unbounded.** Rejected: the other providers return short snippets, and this one alone returns pages. A configurable bound is the smaller change than adding a snippet limit to `dsh-tool-web`, which would change every provider.

**Map `lastModifiedDate` to `publishedAt`.** Rejected: it would label a modification time as a publication date in the model-facing source list.

## Consequences

Selecting `cloudflare` in the Web search card or via `DSH_WEB_SEARCH_PROVIDER` routes `web_search` through Cloudflare. A user must set `accountId` and a token (the card writes the token through the credentials service); until then the search fails with the instruction to set whichever is missing.

The snippet bound means a Ceramic.ai description beyond 2,000 characters is cut by default; raising `snippetMaxChars` trades model context for more page text. Cloudflare's API is in beta, so limits and pricing may change, and a query over 1,024 characters surfaces as Cloudflare's generic `Invalid web search request body` because the adapter does not pre-validate model queries.

The package's 47 unit tests, the client card tests, and the API-proxy settings test pass; every file of the package and of `ui-settings-plugins` is at 100% line and branch coverage. `cloudflare.e2e.ts` runs the provider and the registered `ctx.web` path against the live API when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set (it self-skips otherwise) and passed with an account token. `plugin-config.e2e.ts` selects Cloudflare in the real web app and confirms the API proxy serves its section.
