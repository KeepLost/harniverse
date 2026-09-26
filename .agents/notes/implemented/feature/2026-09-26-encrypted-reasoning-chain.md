# Agent Note: Encrypted reasoning as first-class block data

Status: implemented

English | [中文](2026-09-26-encrypted-reasoning-chain.zh.md)

## Problem

OpenAI Responses reasoning chains replayed statelessly only by accident of pi-ai's internal `thinkingSignature`; the Harness's durable `ReasoningBlock` carried just `text`, so the UI could not tell a provider-generated summary from a full reasoning chain, exports had no first-class ciphertext, and a route switch silently flattened or dropped earlier reasoning without the model ever being told its own history was degraded.

## Decision

Three additive optional fields on `ReasoningBlock` (`packages/llm/llm/src/types.ts`), keeping `SESSION_FORMAT_VERSION` 0 under the additive-only policy (digest verified unchanged):

- `summary: true` — the text is a provider-generated summary of a chain the provider withheld;
- `encrypted` — the provider-issued encrypted reasoning payload, replayable only on the exact route;
- `itemId` — the provider-issued reasoning item id.

The stream translator (`llm-pi-ai/src/stream.ts`) now closes thinking blocks at the terminal `done` event rather than at `thinking_end`, because pi-ai lands the complete reasoning item (id, `encrypted_content`) on the final message's blocks; the closed block lifts those facts out of the parsed `thinkingSignature`, marking `summary` exactly when an encrypted payload exists. An error finish still leaves open thinking blocks to assemble from their deltas, as before; an unparseable signature stays opaque and replays verbatim through the envelope.

On the request side, `piStreamOptions` sends `reasoningSummary: 'auto'` alongside any selected reasoning effort on OpenAI Responses: pi-ai only emits `reasoning.summary` and the `reasoning.encrypted_content` include when a summary option is present, and that include is what makes the chain replay statelessly on the route. Unselected models keep the existing explicit thinking-off dispatch.

Route degradation is now model-visible: when an earlier assistant turn carries reasoning that cannot replay on the request's route — no stored replay metadata, or a different provider/model — `toPiContext` appends exactly one `<system-reminder>` notice to the request history explaining that only the recorded reasoning text survives. The notice is deterministically derived from logged message sources, so the request stays reconstructable from the Session log; the adapter's logger warning remains for operators.

The UI projects `summary` through `AssistantBlock` and the trajectory record: a turn whose reasoning blocks are all summaries labels its collapsible section "Reasoning summary" instead of "Thinking". Exports retain the ciphertext because durable blocks carry it.

## Alternatives considered

**Distinguishing summary deltas from reasoning deltas at stream time.** Not available: pi-ai emits both `response.reasoning_summary_text.delta` and `response.reasoning_text.delta` as the same `thinking_delta` event, so the only truthful marker is the presence of the encrypted payload itself.

**Rebuilding `thinkingSignature` from the new fields when an envelope is missing.** Rejected: the envelope remains the canonical replay carrier and carries strictly more (the complete item JSON); a partial reconstruction would create a second, weaker source of truth.

**Changing `BlockAssembler`'s mismatch handling.** Unchanged deliberately: the envelope and blocks derive from the same terminal message, so a count mismatch is corruption, and pi-ai 0.82.1 already owns the merge-before-filter defense for store:false fragment streams.

## Consequences

Same-route turns replay their reasoning items statelessly with encrypted content; the durable transcript now carries the ciphertext and item ids as first-class data; models that switch routes are told what they lost; the UI distinguishes summaries. Sessions logged before this change simply lack the optional fields. The pi-ai replay envelope needs no version bump: `thinkingSignature` already contained the JSON these fields are lifted from.

## Testing

`pnpm exec vitest run packages/llm/llm-pi-ai packages/llm/llm packages/client/ui-trajectory packages/client/runtime` — new coverage lifts item metadata onto the closed block (enriched, plain, and opaque-signature cases), asserts block-end ordering before usage/finish, and exercises the degrade notice (absent metadata, stale route, reasoning-free history, exactly-one notice). `verify-session-contract-digest` reports the digest unchanged.
