# Agent Note: v0 session-contract digest gate

Status: implemented

English | [中文](2026-09-20-session-contract-digest-gate.zh.md)

## Problem

The permanent v0 session-format freeze was prose policy: nothing mechanically noticed when a change removed a session event type, reshaped an existing payload, or touched the persisted event envelope. Reviewers also needed an explicit compatibility claim and verification for contract-touching changes.

## Decision

The `verify-session-contract-digest` doc-sync leaf compares [the committed digest](../../../../docs/session-contract-digest.json) — a baseline built by AST from `SESSION_FORMAT_VERSION`, every `SessionEventMap` merge's event names and payload texts, the `SurfaceEventType` members, and comment-stripped structural hashes of the envelope declarations — against source. Drift is classified: structural drift (version change, removed events, changed payloads or envelope) fails as a v0-freeze violation; additive drift (new event types) fails as stale until the baseline is consciously regenerated.

The [central-ledger removal decision](../simplification/2026-09-25-remove-central-plugin-ledger.md) partially supersedes this decision's ledger-tail convention. The source-derived freeze check remains active; the owning Agent Note records compatibility rationale and verification when its change refreshes the baseline.

## Alternatives considered

- A runtime compatibility registry consulted on read: rejected — it would duplicate review metadata at runtime and could not gate the type surface itself.
- Digest-only equality like `verify-api-catalog`: rejected alone because a mismatch says nothing about direction; the additive/structural classification is what turns the baseline into an enforcement of the freeze rather than a freshness check.
- Type-level AST diff proving additivity for arbitrary payload changes: rejected as unbuildable without full type resolution; payload-text drift routes to structural review with a documented escape for genuinely additive optional fields.

## Consequences

Every additive session-log vocabulary change consciously regenerates the digest baseline in the same change after its owning Agent Note records the compatibility rationale and verification. A digest change alone never proves semantic compatibility; structural breaking changes remain disallowed. The gate reads source by AST, never built artifacts, so it runs wherever doc-sync runs. The dedicated SQLite schema-change acknowledgement stays deferred until the first real schema change, as decided in the upstream review.

## Scope

[The generator](../../../../scripts/gen-session-contract-digest.ts), [its spec](../../../../scripts/gen-session-contract-digest.spec.ts), the generation and verification scripts in [package.json](../../../../package.json), the doc-sync registration in [run-gates](../../../../scripts/run-gates.ts), and the committed baseline enforce this decision. No runtime package changes are required.
