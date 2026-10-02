# Agent Note: pi-ai 0.87.1 with parse-once patching

Status: implemented

English | [中文](2026-10-02-pi-ai-0-87-1-parse-once.zh.md)

## Problem

pi-ai 0.82.1 was pinned with the [SSE frame-repair patch](2026-10-02-patched-sse-multi-document-frames.md). Upstream 0.85+ introduced a per-delta parse of accumulated tool-call argument JSON: `parseStreamingJson` runs over the whole partial on every `toolcall_delta`, so one large tool call costs O(n²) CPU on the event loop and a multi-megabyte argument stream stalls every session in the process (official `a0f59aac40`, fixing #4739). The wave-4 decision (R12) upgrades to 0.87.1, re-applies the SSE frame repair, and adds the parse-once removal for every protocol Harniverse routes.

## Decision

- **pi-ai 0.82.1 → 0.87.1** (`^0.87.1`, catalog-pinned, `minimumReleaseAgeExclude` updated). The dependency drags `openai` 6.26.0 → 6.40.0, so the OpenAI SDK half of the SSE frame repair was regenerated against 6.40.0 across both shipped builds (`core/streaming.js` and `core/streaming.mjs` — the mjs build is what ESM consumers load).
- **pi-ai patch** (`patches/@earendil-works__pi-ai@0.87.1.patch`) carries two independent repairs: the Anthropic `iterateAnthropicEvents` multi-document split (re-applied verbatim from the 0.82.1 patch), and the removal of the per-delta `parseStreamingJson` at the six delta sites (anthropic-messages, bedrock-converse-stream, mistral-conversations, openai-completions, openai-responses-shared, pi-messages) — matching official `a0f59aac40` on 0.87.1's dist. Terminal parses (`content_block_stop`, `function_call_arguments.done`, `response.output_item.done`, `toolcall_end`) stay, so finalized arguments are exact; partial blocks keep `{}`.
- **Drift adaptations** the gated surfaces surfaced: `baseten` thinking format is withheld (no Harniverse deployment names its `chat_template_args` surface; a route needing it carries the format in its own catalog entry until one does); terminal `pending` and `deferred` stop reasons map to non-retryable `PI_AI_ERROR`; `ToolCall.arguments` narrowed to `JsonObject` (satisfied by construction — the values come from `JSON.parse`); ambient key resolution passes the now-required `signal` (config materialization is not cancellable).
- **Replay identity needed no port**: Harniverse already records the requested model as `model` with `responseModel` separate and validates against the assistant source, which is the semantic official adopted in `6ed596f71b`.
- An `error` event arriving while the caller's signal is already aborted now maps to `aborted` (pi-ai 0.87 delivers caller abort as a terminal error event instead of throwing; ported from the official adapter's `callerSignal` handling).

## Alternatives considered

**Adopt official's compat drift gates wholesale.** Harniverse's compat surface is a deliberately narrow curated set (reasoning dispatch + chat-template kwargs); upstream's new mid-conversation compat fields stay unmodeled rather than growing an unaudited configuration surface.

**Stay on 0.82.1.** The catalog updates (renamed DeepSeek models, per-model level changes) are the point of bumping; the parse-once fix requires the patch anyway.

## Testing

`tool-argument-streaming.spec.ts` (ported from official, extended with an `anthropic-messages` case) drives each routed protocol's stream directly with a 2 KiB argument split into 7-character fragments: every delta's partial arguments stay `{}` and the finalized call carries the exact object. The merged-frame fixtures (OpenAI Responses via the patched SDK, Anthropic via the patched pi-ai parser) stay green; the full llm-pi-ai suite and the keyless ACP snapshot suite pass.

## Consequences

Streamed tool-call deltas no longer expose partial argument objects (consumers see `{}` until the call completes) — the final `tool-call` chunk is unchanged. DeepSeek catalog ids rename (`deepseek-v4-flash` → `deepseek-flash`) and its thinking levels gain `low`; DeepSeek requests now send `max_tokens` (pi-ai's spelling choice) and Anthropic requests carry `?beta=true`. Ported from official `6ed596f71b` + `a0f59aac40` during the 2026-10-02 wave-4 absorption.
