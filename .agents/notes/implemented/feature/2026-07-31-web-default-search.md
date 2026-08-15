# Agent Note: Default Web search in shipped compositions

Status: implemented

English | [中文](2026-07-31-web-default-search.zh.md)

## Problem

The harness had a complete Web capability family—provider registry, DeepSeek/Exa/Perplexity search providers, local fetch, stable model tools, and structured result presentation—but the shipped `dsh web` composition mounted none of it. The model could not discover current information unless a deployment supplied a custom overlay. Merely mounting the existing DeepSeek provider would not complete the WebUI path: the Models page stores `DEEPSEEK_API_KEY` through `ctx.credentials`, while the search provider froze only the process environment at plugin load, so a key entered or rotated in the running UI would not reach search.

## Decision

The base bundle explicitly mounts `dsh-web` with `searchProvider: deepseek-official`, `dsh-web-search-deepseek`, and `dsh-tool-web` with `search: false`, `fetch: false`, and `searchTimeoutMs: 60000`. It does not mount `dsh-web-fetch-http` or select a fetch provider. The [default-closed decision](../simplification/2026-08-15-web-tools-default-closed.md) owns the absence of model-facing Web tools; this note's provider, credential, logging, and timeout decisions apply when a deployment replaces the complete `tool-web` config to enable search. The explicit provider id keeps selection independent of registration order, and the one-minute deployment budget covers an auxiliary DeepSeek Messages request plus server-side retrieval.

DeepSeek search uses the same `DEEPSEEK_API_KEY` credential reference as the official conversation adapter. The provider resolves that reference inside every search through the optional `ctx.credentials` service; only a composition without the seam falls back to the launching process environment, and a non-empty literal `apiKey` remains the programmatic last resort. A stored or rotated Web Models key therefore reaches the next search without restarting or retaining the value on the provider. Because `WebSearchProvider.available()` is synchronous, it treats an installed resolver as locally usable and missing dynamic credentials fail the operation with the provider-specific `WEB_PROVIDER_CREDENTIAL_MISSING` code while the stable tool schema stays registered.

Search keeps its endpoint distinct from chat completions: `DEEPSEEK_SEARCH_BASE_URL` overrides the Anthropic-compatible base, while `DEEPSEEK_BASE_URL` continues to configure conversation requests. Each `web_search` performs an auxiliary DeepSeek Messages call with the native search server tool. Immediately before dispatch, the provider appends a log-only `web/deepseek-search-llm-request` event to the initiating Agent session with the resolved endpoint, API version, and exact secret-free JSON body. Credential preflight remains provider-local and races caller cancellation; neither concern expands the generic Web or credentials seams.

The base mount does not create a Web-specific permission policy and exposes neither Web tool. An overlay-enabled `web_search` still executes outside the shell/filesystem sandbox and approval presets, following `dsh-tool-web`'s existing contract. The shipped `workspace-write` default governs file mutations only; a restricted-network product stance requires a `tools/pre-execute` policy or capability-specific network confinement rather than implying that filesystem access mode governs Web calls.

## Alternatives considered

**Enable `dsh-tool-web` without providers.** Rejected because stable schemas without registered providers would make every enabled call fail. The base keeps provider availability separate from model exposure by mounting the providers while disabling both consumer tools.

**Read `$DSH_HOME/.env` from `cordis.yml` or hoist it into `process.env`.** Rejected because the credential provider owns that document, environment values are read-only overrides, and hoisting would make stored keys unrotatable while bypassing the audited secret boundary.

**Freeze `process.env.DEEPSEEK_API_KEY` at provider load.** Rejected because the Web Models page writes through `ctx.credentials`; the product's documented first-run path must make the next operation work without a restart.

**Keep Web tools in `web.cordis.yml`.** Rejected because it preserves an unexplained tool-roster difference between TUI and Web/headless. The rows are not surface-specific, so `base.cordis.yml` is their one home; the [tool-roster decision](2026-07-31-even-out-shipped-tool-rosters.md) records the shared composition.

**Raise `dsh-tool-web`'s provider-neutral timeout.** Rejected because custom providers and deployments own different latency expectations; the shipped DeepSeek composition owns this deployment budget.

**Enable search and fetch together.** Rejected because default `web_fetch` would allow model-selected anonymous outbound HTTP(S) retrieval to arbitrary URLs. Search covers discovery; deployments that accept broader retrieval can opt into `dsh-web-fetch-http` and set `dsh-tool-web`'s `fetch` option to `true` in their overlay.

## Consequences

Native model requests on every shipped surface omit both Web schemas and their prompt guidance. Explicit search e2e overlays enable `web_search`, drive the real provider against local fixtures, assert the durable auxiliary request and structured result, and pin the settled browser presentation. Search still adds a complete auxiliary model call and may use the native server tool multiple times; its exact secret-free request remains reconstructable from the initiating session log. Shipped-composition and preset tests pin default absence, while provider tests pin missing, stored, and rotated credential behavior plus literal and ambient compatibility.
