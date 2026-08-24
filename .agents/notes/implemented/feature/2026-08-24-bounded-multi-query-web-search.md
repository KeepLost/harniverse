# Agent Note: Bounded multi-query Web search

Status: implemented

English | [中文](2026-08-24-bounded-multi-query-web-search.zh.md)

## Problem

`web_search` accepted one scalar query, so a model comparing several topics had to issue separate tool calls. That multiplied retained tool-call overhead, left cross-query source ordering to call timing, and could not share one result cap. Moving a batch shape into the Web Service Definition or provider adapters would instead make every backend implement batching and would couple the provider-neutral seam to a model-facing orchestration concern.

A batch also needs a complete lifecycle contract. Unbounded fan-out can amplify provider cost; fail-fast rejection can leave sibling requests running after the tool reports failure; concatenating provider lists lets an early query consume the entire result budget; and provider answers without query labels lose provenance when combined.

## Decision

`@deepseek-ai/dsh-tool-web` owns bounded multi-query orchestration. The model-visible `web_search` schema has exactly one required property, `queries`, whose value is an array of strings. It has no scalar `query` property. `searchMaxQueries` defaults to `4`, must be a positive integer, and cannot exceed the fixed protocol maximum `16`; the resolved value appears in the tool description and system-prompt guidance. Validation requires one through `searchMaxQueries` non-blank strings before any provider call.

The Consumer checks the submitted array length before deduplication, then removes exact duplicate query strings while preserving first occurrence order. Whitespace is significant for deduplication even though an all-whitespace item is invalid. This ordering prevents repeated values from evading the configured admission bound.

The provider boundary remains scalar. Each distinct query becomes one concurrent `ctx.web.search({ query, maxResults }, signal)` call, so `WebSearchRequest`, the provider registry, and the DeepSeek, Exa, and Perplexity adapters retain their one-query contract. A one-item array follows the direct path and forwards the caller's signal unchanged; batching is private Consumer orchestration rather than a new capability-seam operation.

For two or more distinct queries, the Consumer starts all searches concurrently under a signal fused from the caller signal and a batch-owned abort controller. The first observed failure aborts that fused signal for every sibling. The Consumer then awaits `Promise.allSettled()` for every started search before it returns the first failure. Caller cancellation uses the same quiescent path. A provider must honor cancellation for prompt shutdown, but the tool does not claim settlement until even an uncooperative sibling has settled.

Successful results merge under one global `searchMaxResults` cap. Sources are visited by provider rank and then query order, producing a fair round-robin across queries; exhausted result lists drop out naturally. Exact URL strings are deduplicated globally, preserving the first source object encountered. The merged result sets `truncated` when any provider result was truncated or when the merge drops a unique source at the global cap.

Every non-empty provider answer is retained in submitted query order as a `### <query>` section. The combined answer, merged structured sources, and truncation flag become the canonical tool value and durable `tool/result` metadata used to reproduce the Web search card. The ordinary durable `tool/call` stores the exact `queries` array, so both the model-visible input and the merged output remain reconstructable from the Session log.

The scalar legacy shape `{ query: "..." }` is deliberately rejected as `INVALID_ARGS`. Harniverse is pre-release and has no persisted or external compatibility commitment for this tool schema; a one-query caller uses `{ queries: ["..."] }`. No dual schema, argument rewrite, or hidden fallback is shipped.

## Testing

`packages/web/tool-web/tests/tool-web.spec.ts` pins the required array-only schema, default and configured query bounds, the protocol maximum, validation-before-provider behavior, exact query and URL deduplication, concurrent start, query-labelled answers, round-robin continuation after a shorter result is exhausted, the global result cap, sibling cancellation, caller cancellation, and quiescence before failure returns. `packages/web/tool-web/tests/integration.spec.ts` exercises a one-item array through the real Web seam and Exa provider adapter with only the network boundary replaced.

`apps/web/tests/web-search-round.e2e.ts` and its keyless replay fixture exercise a two-query tool call through a real assembled Web composition and deterministic local provider endpoints. They pin two scalar provider requests, the durable `tool/call` `queries` array, the merged and capped `tool/result` text and metadata, exact shared-URL deduplication, and the settled browser card. The additional Exa and Perplexity compositions prove that the same two-query Consumer contract composes over both scalar adapters without an external API key.

## Alternatives considered

**Add `queries` to `WebSearchRequest` and batch inside every provider.** Rejected because batching is a model-tool orchestration concern. It would widen the Service Definition, duplicate concurrency and cancellation policy across adapters, and make providers with only scalar APIs simulate the same fan-out independently.

**Keep scalar `query` and ask the model to issue parallel tool calls.** Rejected because each call would own a separate result cap and retained envelope, while source fairness, exact URL deduplication, answer provenance, and sibling quiescence could not be guaranteed across calls.

**Accept both `query` and `queries`.** Rejected because the pre-release repository has no compatibility promise requiring two model-visible shapes. A union would spend schema tokens, require precedence rules for calls containing both properties, and preserve a path that cannot express the feature.

**Return as soon as one sibling fails.** Rejected because provider work could continue and publish side effects after the tool result had become final. Cancellation followed by complete settlement gives the operation one observable lifecycle boundary.

**Concatenate results query by query.** Rejected because an early query could consume the global cap before later queries contribute any source. Rank-first round-robin gives every non-empty query a fair opportunity while retaining deterministic query order.

**Normalize queries or URLs before deduplication.** Rejected because case folding, whitespace rewriting, redirects, fragments, and URL canonicalization can change provider meaning or collapse distinct resources. Exact string identity is deterministic and does not invent equivalence policy.

## Consequences

One tool call can search several related formulations while retaining a single bounded result and one durable presentation. The default permits four concurrent provider requests, while deployments may reduce it or raise it only as far as sixteen; provider cost and rate-limit pressure therefore increase with the configured bound but never with an unbounded model array.

Provider packages and the Web Service Definition remain plugin-native and scalar. The Consumer bears the orchestration complexity: it allocates one request per distinct query, waits for full quiescence on failure, and may wait for a provider that ignores cancellation. Fair merging can omit a lower-ranked source from an earlier query in favor of a top-ranked source from a later query, which is the intended cost of sharing one global cap.

The schema change is intentionally breaking before release. Stored fixtures and callers must use `queries`; rejecting `{ query }` keeps one unambiguous contract and avoids carrying speculative compatibility code into the first released format.
