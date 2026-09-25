# Agent Note: pi-ai mixed-protocol routes and protocol-owned request assembly

Status: implemented

English | [中文](2026-09-25-pi-ai-mixed-protocol-routes.zh.md)

## Problem

The pi-ai adapter inherited four behaviors that a multi-provider deployment cannot live with, all confirmed against pi-ai 0.82.1 by wire-level inspection and live requests:

1. **One wire protocol per route.** `api` applied to the whole route, so an OpenAI-style catalog spanning Responses and Chat Completions could not host a model of the other protocol, and pointing one model at another protocol meant moving every model onto it.
2. **`streamSimple()` collapses the reasoning selection.** An absent option and an explicit `off` both become "no reasoning", which Anthropic Messages wires as an explicit `thinking: disabled` and Responses as an explicit minimal effort — silently changing the request nobody made on models whose provider default is to think. The same path also lets `adjustMaxTokensForThinking` raise the caller's output cap by the thinking budget (W4), and requires an Anthropic listing to stop after one page.
3. **Tool results could land after intervening user text.** pi-ai's history transform answers a tool call with a synthetic "No result provided" when any user message intervenes between the call and its result.
4. **Discovery answered only from the installed catalog** with no way to force a live endpoint reading, no row-level source, and an Anthropic listing that ignored `has_more`.

## Decision

**Per-model protocols (route default, entry override).** Each model resolves its protocol as its own entry's `api` → the route's → its installed catalog entry's → the one its shipped siblings agree on. A resolved protocol other than the installed entry's own is a repoint: the entry's protocol-specific fields no longer apply. Provider construction reuses the installed catalog provider only when the profile names no `api` and every model keeps its catalog description; every other route serves per model — catalog-described models delegate to the catalog provider, each remaining protocol gets one lazily built provider instance — so one route mixes protocols without splitting into two user-visible providers.

**Protocol-owned request assembly.** `anthropic-messages` and `openai-responses` requests go through the protocol's own `stream()` options assembled by `piStreamOptions()`, which keeps default / off / level / budget apart: Anthropic gets a wire-required `max_tokens` (caller cap, else the model capability), no thinking field when unselected, an explicit disable for `off`, effort for adaptive models, and a budget fitted inside the caller's cap without ever raising it (below 1,024 refused `UNSUPPORTED_OPTION` before network I/O); Responses carries `max_output_tokens` only when the caller names one (sub-16 refused) and `reasoning.effort` only for a selected non-off level. Temperature travels only where the protocol can accept it (no thinking capability, explicit off, or Responses unselected). Profile `thinkingBudgets` values must be integers ≥ 1,024. Every other protocol keeps `streamSimple()`.

**Tool results adjacent to their calls.** Both context-conversion paths emit each tool result before the user text of the same turn, so nothing intervenes between a call and its answer.

**Discovery with source and endpoint mode.** The wire request gained `mode: 'endpoint'` (pass on the catalog answer; needs a baseURL) and each reply row carries `source: 'catalog' | 'endpoint'`. The Anthropic listing follows `has_more`/`last_id` (last row id as fallback) up to ten pages, failing `DISCOVERY_FAILED` beyond, and stops on a page that cannot be continued. The settings UI offers both fetch actions, tags catalog-sourced candidates, lets each model row name its protocol, and probes the endpoint a cleared override leaves behind (the composition base, not the stored effective value).

**Known Limitations recorded rather than changed:** a configured/adopted `maxTokens` is a deployment choice and becomes the seam's request default (no per-entry "capability only" spelling), and an unselected reasoning model on Responses is dispatched by pi-ai with thinking off. Both are documented in the package README.

## Alternatives considered

**Split mixed-protocol providers across two route keys:** rejected — it doubles credentials and surfaces for one endpoint and breaks single-route model catalogs.

**Keep `streamSimple()` and pre-adjust options to counter its collapse:** rejected — fighting the common path per protocol re-implements the same translation with worse information, and the cap-raising side effect cannot be countered from outside.

**Force every protocol through `stream()`:** rejected — `streamSimple()`'s own dispatch is correct for the remaining protocols, and owning their option assembly would take on every provider's dialect for no behavioral gain.

**Silent `has_more` truncation vs. a page bound:** a bound of ten pages with an explicit failure was chosen; an unbounded follow loops on a misbehaving endpoint, and silent truncation hides exactly the long-tail models pagination exists to surface.

## Consequences

A catalog route whose route-level `api` is set no longer reuses the installed catalog provider (every model is potentially repointed); provider reuse narrows to the all-catalog case, which preserves the Bedrock/Smithy reconstruction constraint. The UI protocol field on a catalog route now reads as the default its models inherit, with per-row overrides, and the unset option is always offered so a stored override can be left behind. History conversion sends results-first turns, which changes the wire order of user turns that mix text and tool answers on every protocol. Discovery replies grew one field (`source`), additive on the wire.

## Verification

Wire-level assertions run against real compositions and a mock SSE server: mixed-protocol routes dispatch per model (`adapter.spec.ts`), the protocol-owned request assembly tests pin `max_tokens`, thinking-field absence/presence, budget fitting, the sub-floor refusals, and temperature gating on the wire, and the Anthropic request body was confirmed live (`{model: 'claude-sonnet-5', max_tokens: 128000}` with no thinking field). Discovery tests cover mode/source/pagination including the page bound and the uncontinuable page. Focused suites: llm-pi-ai (264 tests), ui-settings-models (274 tests, per-file 100% coverage), apiproxy config round-trip, and `test:gui` green. Live model checks: `gpt-5.6-sol` (function_call), `gpt-6-astra` (message + function_call), `claude-opus-5` (tool_use) all HTTP 200. Snapshot suites (cli-mock-llm, examples) exercise deepseek-official only and do not cover the pi-ai wire; that gap is why the adapter tests assert wire bodies directly.
