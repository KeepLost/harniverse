# Agent Note: 413 request-body recovery — settle images, compact, retry

Status: implemented

English | [中文](2026-11-03-body-limit-recovery.zh.md)

## Problem

A request the provider rejects as too large — `413 Failed to buffer the request body: length limit exceeded` (DeepSeek), or any transport-level body cap on other providers — killed the session's turn: the waterfall surfaced the failure, nothing shrank the payload, and every retry hit the same wall. Images already in the surface were the usual culprit; text-only histories almost never trip body caps in practice.

Root cause: `agent/request-error` handlers covered `CONTEXT_WINDOW_EXCEEDED` (compaction-basic) and rate limits, but no classification existed for request-BODY size, and no reducer ran on that path — the recoverable case (images are settleable via the existing `image/offload` policy, text is compactable) was treated as fatal.

## Decision

- `dsh-llm` grows `REQUEST_BODY_TOO_LARGE_CODE` and `isRequestBodyTooLargeError()`; the pi-ai stream classifier and both DeepSeek protocol adapters (chat-completions `httpErrorCode`, messages `providerError`) map their transport-specific signals onto the classification, so every provider path speaks one predicate.
- **`@deepseek-ai/dsh-compaction-body-limit-recovery`** (base bundle row, after `compaction-image-offload`) hooks `agent/request-error`: on a body-limit failure it (1) runs `resolveImageOffloadDecisions(events, { setting: 'unlimited', pressureCount: Infinity })` — settle every still-active image occurrence, oldest first — appends the `image/offload` event, (2) calls `compaction.compactIfNeeded(agent, 'context-overflow', signal)` when a compaction engine is composed, (3) retries when any deterministic reduction landed (`decisions.length > 0`, compaction returned a result, or the surface's `replaceGeneration` advanced — a compaction that threw mid-flight may still have appended events).
- The retry budget is three recoveries per session, reset on `assistant/message`; exhaustion surfaces the original error. Cancellation during recovery preserves the original failure (`next()`), and non-body-limit failures pass through untouched.
- Failure of the optional compaction leg is non-fatal: the image settlement is already durable, and the retry decision reads every landed reduction rather than the call's outcome.

ponytail: this is a reactive body-limit recovery — the ceiling is a transport cap we discover only by hitting it. The upgrade path is a proactive request-body budget (estimate the serialized request before send and pre-settle/pre-compact), which needs provider-specific size signals worth its own design; until then the bounded reactive loop is the safety net.

## Alternatives considered

- **Treat it as context-overflow** (`CONTEXT_WINDOW_EXCEEDED`) — rejected: different failure (transport cap vs model window), different reducer economics; overloading the code would trigger maxTokens halving and retry policies tuned for a different regime.
- **Strip images without compaction** — rejected for the text-heavy tail: sessions with long text and no images still trip caps; compaction is already the composed, policy-driven reducer.
- **Unlimited retries** — rejected: a genuinely irreducible body (one enormous attachment) would loop; three bounded attempts with reset-on-success covers the transient cases without a live loop.

## Consequences

- Any provider surfacing a body-size signal through the classified adapters now degrades gracefully instead of killing the turn; providers without classification fall through unchanged.
- `image/offload` decisions are unlimited-setting: after recovery the surface holds no images (they remain as durable offload references); a later context-overflow may still compact text.
- Evidence: `compaction-body-limit-recovery` suite — classification pass-through, whole-history settlement with retry, compaction coordination, budget exhaustion and reset, cancellation ordering (13 tests, per-file 100% on `src/index.ts`); classifier branches pinned in the llm-pi-ai / llm-deepseek suites.
