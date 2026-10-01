# Agent Note: Patched SSE parsers deliver gateway-collapsed multi-document frames

Status: implemented

English | [中文](2026-10-02-patched-sse-multi-document-frames.zh.md)

## Problem

The owner's OpenAI-relay route failed every turn with `Unexpected non-whitespace character after JSON at position N (line 2 column 1)`, retried twice, and died: the gateway intermittently drops the blank line between two SSE events, so one event's `data:` payload carries two complete JSON documents (`{...}\n{...}`). The OpenAI and Anthropic SDK streams join multi-line data per SSE spec and `JSON.parse` the joined payload, so the second document is trailing garbage. The same class reaches the `anthropic-messages` route, where pi-ai's own `iterateAnthropicEvents` parser (`parseJsonWithRepair` over the joined `state.data`) has the identical shape.

Reproduction was captured on the real line: a local tap proxy recorded the wire, and the owner's session logs show deterministic identical failures across retries (the relay replays the same malformed bytes for a cached `prompt_cache_key`). The prior note [2026-10-01-anthropic-ambient-key-precedence](2026-10-01-anthropic-ambient-key-precedence.md) rejected client-side tolerance because "retrying reaches the healthy path without owning a parser" — the retry evidence disproves that premise: the malformed frames are deterministic per response, so no retry count recovers, and OpenCode against the same gateway succeeds only because its provider stack parses tolerantly.

## Decision

- `patches/openai@6.26.0.patch`: `Stream.fromSSEResponse`'s two parse sites parse through `parseJSONDocuments`, which returns `[JSON.parse(data)]` normally and, when that throws, splits the payload on newlines and parses each non-empty line, yielding every document as its own event; a payload the split cannot repair rethrows the original error.
- `patches/@earendil-works__pi-ai@0.82.1.patch`: `iterateAnthropicEvents` gains the same split-repair around `parseJsonWithRepair`, preserving its wrapped error text and the `message_start`/`message_stop` bookkeeping across the split events.
- The Anthropic SDK itself is not patched: pi-ai's anthropic path consumes the raw response (`.asResponse()`) through its own parser, so the SDK's stream decoder is not on the affected path.

## Alternatives considered

- **Retry-only, per the prior note's rejection** — rejected: retries replay the same cached malformed bytes; the failure is deterministic, not transient.
- **A normalizing `fetch` wrapper re-framing the byte stream before the SDKs parse it** — rejected: pi-ai's client constructors accept no `fetch` override, so threading one would be a larger vendored patch across two call layers than the two parser-local repairs.

## Consequences

A spec-compliant server never notices the change: single-document payloads take the unchanged fast path. A gateway that collapses events loses at most the theoretical multi-line single-JSON payload the SSE spec permits and OpenAI-protocol servers never send. Pinned by `tests/adapter.spec.ts` ("delivers every merged OpenAI/Anthropic frame a gateway collapses into one data payload"), which drives the real adapter over a mock server serving the malformed frame.
