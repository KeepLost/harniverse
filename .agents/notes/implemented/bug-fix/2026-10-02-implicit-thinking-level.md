# Agent Note: An unspecified request sends the implicit middle thinking level

Status: implemented

English | [中文](2026-10-02-implicit-thinking-level.zh.md)

## Problem

Reasoning-capable models whose requests name no thinking level inlined their chain of thought into the visible reply text: the owner's `anthropic`/`claude-opus-4-8` turns arrived as a single text block opening with the model's deliberation, and `deepseek`/`deepseek-v4-pro` did the same through the official API. Wire captures on the real line showed why — with no explicit thinking request, the Anthropic relay converts the upstream thinking block into untagged text, and DeepSeek V4 (only `high`/`max` supported) receives `thinking: {type: "disabled"}` and inlines its reasoning into `content`. OpenCode does not show the leak because it requests thinking explicitly by default; custom hand-declared routes never leaked because their models ride a reasoning-content field the gateways preserve.

## Decision

- `implicitThinkingLevel(model)`: for a model whose reasoning capability is described, the implicit level is pi-ai's `clampThinkingLevel(model, 'medium')` (a DeepSeek V4 clamps to `high`); `off` clamping to nothing means no implicit level.
- `effectiveDefaultEffort(profile, model)`: the model's `defaultReasoningEffort` pin wins over the route's `reasoning`; the explicit `default` pin returns `'pinned-none'`, which suppresses both the route default and the implicit level — naming no effort is that model's configured answer.
- `PiAiAdapter.stream` sends `options.reasoningEffort ?? effectiveDefaultEffort ?? implicitThinkingLevel`, and `resolveModel` reports the same value as `reasoning.defaultEffort`, so the listing and the wire agree.

## Alternatives considered

- **Keep the provider default and strip leaked thinking heuristically** — rejected: the untagged deliberation has no boundary marker on the wire; any heuristic would corrupt legitimate prose.
- **Default every route through the existing `reasoning` config field** — rejected: it would push a deployment-wide level onto models that do not support it and bury the fix in configuration instead of correcting the seam's default.

## Consequences

An unspecified request on a reasoning-capable model now costs thinking tokens by default; a deployment that wants a model's provider default pins `defaultReasoningEffort: default`, and explicit `off` still disables. Verified on the real line: `claude-opus-4-8` and `deepseek-v4-pro` both return separated `reasoning` + `text` blocks where the same prompts previously leaked. Pinned by `tests/adapter.spec.ts` ("clamps an unspecified request to the nearest supported thinking level", "keeps an explicit defaultReasoningEffort pin off the wire", and the rewritten unspecified-effort wire tests).
