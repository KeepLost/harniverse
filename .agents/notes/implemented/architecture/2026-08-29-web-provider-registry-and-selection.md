# Agent Note: Web provider aggregation and explicit selection

Status: implemented

English | [中文](2026-08-29-web-provider-registry-and-selection.zh.md)

## Problem

The web capability has independent search and fetch operations, while one vendor may implement both and another may implement only one. Model-facing tools also need to use providers added after the tool plugin starts, including temporary Host plugins created through the dynamic Cordis runner. A registry that chooses by registration order or silently changes providers after failure makes the result's origin and behavior unclear.

## Decision

`WebRuntime` owns one registry per `ctx.web` instance and exposes two capability kinds: `search` and `fetch`. A provider can register either capability or both as one aggregate `WebProvider`; the registration disposer removes every capability contributed by that provider. The legacy `registerSearchProvider` and `registerFetchProvider` methods remain as single-capability wrappers.

Each operation accepts an optional open-string `provider` id. Selection is resolved at execution time in this order:

1. The operation's explicit provider id.
2. The configured default for that capability.

An operation without either id fails with `WEB_PROVIDER_DEFAULT_MISSING`. An unknown or unavailable selected provider fails directly with a structured `WebError`; the runtime never auto-selects, aggregates, retries, or falls back to another provider. Search and fetch have independent defaults in the live `web` settings section. The settings and composition environment values identify defaults, not credentials or hidden retry behavior.

`listProviders(capability?)` returns detached, non-secret ids and capability kinds. The model-facing `dsh-tool-web` consumer uses this live catalog in dynamic prompt context and keeps the provider argument open rather than generating a static enum. A provider registered after tool schemas are assembled is therefore eligible for the next operation, and its id appears in the next prompt assembly. An unknown provider error also names the registered ids.

Provider plugins own their complete vendor integration: endpoint construction, credentials, request and response mapping, cancellation, bounds, and provider errors. A provider may expose multiple operations without making those operations share a model-facing schema. Firecrawl uses this aggregate shape for Search and markdown Scrape; Tavily, Brave, Kagi, Exa, Perplexity, and DeepSeek provide search, while the anonymous HTTP provider provides fetch.

Dynamic Host plugins can inject `web` and register a structural provider during `cordis_run`. `cordis_define` only stores source, and a regular package written to disk is not discovered by this registry. Dynamic registrations follow the plugin fiber and disappear on stop, undefine, plugin unload, or process restart. The shared process registry means a running dynamic provider may be visible to other sessions; dynamic Cordis remains an opt-in, trusted runtime extension rather than a security boundary.

Provider credentials use the existing `ctx.credentials` contract and are resolved per operation. Settings surfaces write values through `credentials.set` and expose only configured/source/writable facts. The existing precedence remains process environment, managed credentials file, project `.env`, then user `.env`; Web providers do not create an exception. Provider-specific settings remain in the provider namespace, and model arguments never carry keys or vendor-private controls.

`dsh-tool-web` applies the same model-facing untrusted-content boundary to every provider result, including provider-produced Markdown. `artifact_read` has its own unconditional artifact boundary and does not share Web sanitization or marker logic.

## Alternatives considered

**One provider registry for each operation only.** Separate registries are retained internally because search and fetch have different contracts, but aggregate registration is the public lifecycle unit when one vendor owns both. This avoids duplicate credentials and partial teardown without forcing unrelated provider capabilities into one interface.

**Implicit single-provider selection.** Removed in favor of an explicit default or operation id. A deployment with several providers must not acquire semantics from Loader or HMR order, and a deployment with no default must tell the model exactly what is missing.

**Automatic fallback or provider aggregation.** Rejected. A fallback changes authorization, cost, latency, and result provenance after the caller selected a provider. The caller can make a new explicit tool call with another id when that is appropriate.

**A static provider enum or a separate provider-list tool.** Rejected. Dynamic Cordis providers can appear after tool schema generation. An open string plus the live prompt catalog and actionable selection errors keeps the tool schema stable without adding another model round trip.

**Loading packages by scanning files or npm names.** Rejected. Loader composition remains the authority for normal packages; the dynamic runner is the authority for temporary in-memory packages. WebRuntime only consumes providers that have completed registration in the current process.

## Consequences

The model can choose a concrete search or fetch backend and receives that backend's direct success or failure without hidden substitution. A provider added by a successfully running Host dynamic plugin is usable on the next Web operation, while `cordis_define` alone has no runtime effect. The live catalog is metadata only and does not promise credentials, health, or successful network access. Provider implementations remain independently testable and can add vendor capabilities without changing the model-facing tools.

The normalized search and fetch contracts remain deliberately small. Provider-specific filters, AI answer generation, crawl jobs, and structured extraction are not smuggled into `web_search` or `web_fetch`; they require their own capability contract when a concrete consumer exists. The HTTP fetch provider's existing private-network limitation remains documented and prevents treating `web_fetch` as a general SSRF-safe boundary.
