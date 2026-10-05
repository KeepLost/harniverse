# Agent Note: The session-title thinking lock travels to llm-pi-ai

Status: implemented

[中文](2026-10-06-session-title-thinking-lock-pi-ai.zh.md) | English

## Problem

A deployment routed session-title generation through `dsh-llm-pi-ai` on reasoning-capable models and the auxiliary call failed on two distinct paths:

- **Anthropic Messages** — the adapter resolves an unspecified effort to the implicit middle level; a budget-thinking model then requires a ≥1,024-token thinking budget inside the caller's cap. With the title budget (32–64 tokens) the request is refused with `UNSUPPORTED_OPTION` before any network I/O.
- **OpenAI Responses and OpenAI-compatible gateways** — the resolved level sends thinking on the wire; reasoning tokens count against the same small cap, the finish reason lands `length`, and the title Consumer reports `title output reached maxOutputTokens`.

`dsh-llm-deepseek` was unaffected: it already maps `GenerateOptions.purpose: 'session-title'` to thinking-disabled as a deployment lock. `dsh-llm-pi-ai` resolved `purpose` nowhere, and the session-title plugin never selects an effort, so every reasoning-capable pi-ai route hit one of the two failures.

## Alternatives considered

- Honor an explicit `reasoningEffort` over the lock: rejected — the title Consumer never selects one, and a permissive lock would reintroduce the budget refusal through any caller that does.
- Raise only the deployment budget and resolve nothing in the adapter: rejected — a budget-thinking Anthropic route still refuses `maxTokens < 1,024 + cap` outright, so no budget value fixes both failure classes at once.

## Decision

- **The lock, not a default**: in `PiAiAdapter.stream()`, a request with `purpose: 'session-title'` resolves reasoning to `off` *before* profile defaults, model defaults, or explicit `reasoningEffort` selections apply — mirroring the llm-deepseek lock, including its refusal to be crossed by an explicit selection. Anthropic Messages wires `thinking: {type: disabled}`; OpenAI Responses sends no effort field; `streamSimple()` protocols express off by omitting the reasoning option, their only spelling of it.
- **Wire-bound honesty**: a model whose endpoint always reasons (a reasoner-only deployment behind an OpenAI-compatible gateway) has no off spelling to send. For those routes the fix is the deployment budget: the shipped base composition and the session-title example raise `maxOutputTokens` from 64/32 to **256**, keeping a bounded title call that tolerates reasoning spend instead of refusing.
- llm-pi-ai's README documents the lock beside its reasoning-resolution rules and carries the wire-bound limitation in Known Limitations; the session-title-llm README now names both adapters instead of "other adapters".

## Consequences

- Session-title generation on pi-ai routes no longer fails on budget-thinking Anthropic models or burns its cap on dispatched thinking; deployments keep `maxOutputTokens` as the only lever for endpoints that ignore the lock.
- An explicit `reasoningEffort` on a session-title request is now silently overridden by the lock, matching llm-deepseek; no shipped caller selects one.

## Verification

- `packages/llm/llm-pi-ai/tests/adapter.spec.ts` — a session-title request over a `reasoning: 'max'` profile lands `thinking: {type: 'disabled'}` with no `reasoning_effort` (and an explicit high does not cross the lock); a budget-thinking Anthropic model with `maxTokens: 32` completes with `max_tokens: 32, thinking: {type: 'disabled'}` where the pre-lock behavior was `UNSUPPORTED_OPTION`. Both tests were confirmed RED against the unmodified adapter before the fix.
- `scripts/verify-cordis-config.ts` passes over the raised composition values.
