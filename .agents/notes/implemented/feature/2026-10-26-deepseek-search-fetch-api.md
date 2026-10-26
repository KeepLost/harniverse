# Agent Note: DeepSeek Search and Fetch APIs replace the Messages-based search

Status: implemented

English | [中文](2026-10-26-deepseek-search-fetch-api.zh.md)

## Problem

The shipped base composition selected `deepseek-official` — the `dsh-web-search-deepseek` provider — as its default Web search. That provider spoke the Anthropic-compatible Messages API with the `web_search_20250305` server tool, so one search cost a complete model turn in latency and tokens. It existed because, at wave-4 W06 absorption, DeepSeek exposed no dedicated search endpoint.

On 2026-10-15 the official service opened direct Search and Fetch endpoints (`/v1/tools/search`, `/v1/tools/fetch`): one plain HTTP request per operation, structured results or page Markdown, billed per call. Official DSH added the `dsh-web-deepseek-api` plugin; the wave-5 survey recorded it as row 5.

## Decision

Absorb the official plugin as `packages/web/web-deepseek-api`, adapted to Harniverse contracts, and retire `dsh-web-search-deepseek` entirely (owner decision 2026-10-26).

The new package registers `deepseek-search-api` (search) and `deepseek-fetch-api` (fetch) into `ctx.web` over one live settings section (`web-deepseek-api`: `apiKey` secret, `apiKeyEnv` defaulting `DEEPSEEK_API_KEY`, `baseURL` defaulting the official endpoint, `count` 1–50 default 10, `sendOriginalQuestion` default true). Both providers project the section once per operation, so a committed change reaches the next operation without re-registration. The base composition row swaps to the new plugin and the default `searchProvider` becomes `deepseek-search-api`; `$DSH_WEB_SEARCH_PROVIDER` continues to override.

Adaptations from the official shape: the account-token authentication path is stripped (the C2 DeepSeek-account family stays rejected); the volatile-config pattern becomes our `installSettingsSection` projection; `ready()` is omitted (our `WebSearchProvider` interface has no readiness member); `ori_question` reads the initiating session's latest human prompt through `deriveMessages()` exactly as official does; per-result `summary` values are dropped because our `WebSearchSource` vocabulary has no per-source summary field (the seam README already records DeepSeek as summary-less).

Retirement removes the package, its `web/deepseek-search-llm-request` session event, the `web-search-deepseek` settings namespace, and every composition, UI, SDK, and documentation reference. Deployments that pinned `searchProvider: deepseek-official` in a user layer must reselect; a configured-but-missing provider fails the search with `WEB_PROVIDER_CONFIGURED_MISSING`, which is the seam's standing answer.

## Alternatives considered

**Keep both providers.** The Messages path's only remaining value is a cheaper entry for users without Search-API billing; that is not ours to arbitrate, and keeping a model-turn-priced search as a selectable default invites accidental cost. Official keeps both with Messages as default; we take the direct API as the only DeepSeek path.

**Port `ready()` onto the seam.** No consumer asks for per-route readiness on our seam; adding an interface member for an upstream pattern with no downstream caller violates the smallest-contract rule.

## Compatibility

Retiring the provider removes the `web/deepseek-search-llm-request` `SessionEventMap` member, which the session-contract digest records as a structural (non-additive) v0 change. The rationale for consciously regenerating the baseline in this change:

- The event was a plugin-owned pre-dispatch record, never a core vocabulary member: it shaped no surface reconstruction, no derived message, and no request prefix — a reader that ignores it reconstructs the identical session.
- Pre-retirement logs must keep opening. The type therefore joins the generated `KNOWN_SESSION_EVENT_TYPES` as a documented retired entry (a static `RETIRED_SESSION_EVENT_TYPES` list in `scripts/gen-persistence-catalog.ts`), so `assertEventsSupported` admits it while no declaration merge remains. The events load as inert data, exactly like `ignorable` envelope events.
- No writer emits the type anymore, so the writer-side bump criterion ("bump when an older runtime could no longer handle a new log") cannot fire: newer logs never contain the event.

Verification: a persistence regression test loads a log containing the retired event type through the production read path.

## Consequences

- One DeepSeek search is one HTTP request; no auxiliary model turn is spent or recorded, so the `web/deepseek-search-llm-request` event and its persistence-catalog row disappear.
- The browser Web search card gains a fetch option (`deepseek-fetch-api`) and DeepSeek fields become `baseURL` / `count` / `sendOriginalQuestion`.
- Verification: provider and settings suites (24 tests), base composition spec, apiproxy settings-allowlist spec, SSH remote-runtime spec, and the web e2e round (`web-search-round`, `shipped-composition`, `plugin-config` with a refreshed dialog golden) all pass against the new provider; the search double serves the Search API wire shape and asserts the exact request envelope, Bearer credential, count clamping, and the bounded `ori_question`.
