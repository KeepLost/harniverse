# Agent Note: v0 session-contract digest gate and the Compat/Verify ledger tail

Status: implemented

English | [中文](2026-09-20-session-contract-digest-gate.zh.md)

## Problem

The permanent v0 session-format freeze was prose policy: nothing mechanically noticed when a change removed a session event type, reshaped an existing payload, or touched the persisted event envelope. The `PLUGINS.md` ledger also recorded contract-touching changes no differently from cosmetic ones, so a reviewer had no declared compatibility stance to check.

## Decision

Two doc-sync leaves now enforce the freeze. `verify-session-contract-digest` compares `docs/session-contract-digest.json` — a baseline built by AST from `SESSION_FORMAT_VERSION`, every `SessionEventMap` merge's event names and payload texts, the `SurfaceEventType` members, and comment-stripped structural hashes of the envelope declarations — against source. Drift is classified: structural drift (version change, removed events, changed payloads or envelope) fails as a v0-freeze violation; additive drift (new event types) fails as stale until the baseline is consciously regenerated. `verify-ledger-compat` requires every `PLUGINS.md` ledger row after the `compat-convention-start` marker to declare a `Compat:` stance (`none` when no durable or public contract is touched) and, for every non-`none` claim, the `Verify:` command that re-verifies it; the historical rows before the marker stay exempt.

## Alternatives considered

- A runtime compatibility registry consulted on read: rejected — it would invent a second compatibility registry beside the ledger the review decision explicitly avoided, and could not gate the type surface itself.
- Digest-only equality like `verify-api-catalog`: rejected alone because a mismatch says nothing about direction; the additive/structural classification is what turns the baseline into an enforcement of the freeze rather than a freshness check.
- Type-level AST diff proving additivity for arbitrary payload changes: rejected as unbuildable without full type resolution; payload-text drift routes to structural review with a documented escape for genuinely additive optional fields.

## Consequences

Every future session-log vocabulary change regenerates the digest baseline in the same commit and carries a `Compat:`/`Verify:` tail on its ledger row; a digest change alone never proves semantic compatibility, so the claim and the command are the review surface. The gate reads source by AST, never built artifacts, so it runs wherever doc-sync runs. The dedicated SQLite schema-change acknowledgement stays deferred until the first real schema change, as decided in the upstream review.

## Scope

`scripts/gen-session-contract-digest.ts` with its spec, `scripts/verify-ledger-compat.ts` with its spec, the two `package.json` scripts and `docSyncLeafGates` wirings, the committed baseline, the `PLUGINS.md` marker and Maintenance Rule, and this note. No runtime package changed.
