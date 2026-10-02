# Agent Note: compaction summary cap defaults to 32768

Status: implemented

English | [中文](2026-10-02-compaction-summary-cap-32768.zh.md)

## Problem

`compaction-basic`'s `maxTokens` — the upper bound for the summarization call, before the matching request policy, the model's output capacity, and the provider-anchored safe context space reduce it — defaulted to `8192`. Summaries of long agent sessions routinely wanted more room than that, and the bound silently truncated them; every deployment had to discover and override the knob by hand.

## Decision

Raise the default to `32768`, and only that:

- `resolveConfig` materializes `config.maxTokens ?? 32_768`; an explicit configuration still wins unchanged.
- `compaction-lossless` states the same default in its README row because it reuses `BasicCompactionConfig` — there is no separate lossless default to move.
- Documentation (`compaction-basic` README pair, `compaction-lossless` README pair, config catalog pair) records the new number.

Rejected: a 65536 headroom default (a summary that large consumes the very context the compaction is trying to free) and any change to reasoning-token handling on the summarization call (reasoning stays on, as today).

## Consequences

Compaction summaries may now run to 32k tokens before the outer bounds clamp them. Deployments that pinned `maxTokens` explicitly see no difference. The number remains an upper bound, not a target: shorter sessions still summarize shorter.

## Tests

`pnpm exec vitest run packages/compaction/` — 406 tests, including `uses low-friction service-wide defaults` now asserting `maxTokens: 32_768`. `pnpm exec tsc -p packages/compaction/compaction-basic --noEmit` and `compaction-lossless` are clean; translation pairing and the config catalog verify green.
