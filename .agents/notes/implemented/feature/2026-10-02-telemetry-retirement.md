# Agent Note: Session telemetry retired

Status: implemented

English | [中文](2026-10-02-telemetry-retirement.zh.md)

## Problem

The telemetry surface — `session-telemetry` (the `ctx.sessionTelemetry` seam and `session-telemetry/record` waterfall), `session-telemetry-otel` (OTLP/HTTP delivery in `FULL`/`FEEDBACK_ONLY`/`DISABLED` modes), and `anonymous-user-id` (the `$DSH_HOME/.anonymous-user-id` correlation id) — shipped disabled everywhere, had no consumer in any owner deployment, and still cost real surface: the `DSH_TELEMETRY_MODE`/`DSH_TELEMETRY_OTLP_URL`/`DSH_TELEMETRY_DISABLED` environment seams, boot-time opt-out patches in the CLI and remote server, identity headers on every `llm-deepseek` request, and a sharing disclosure plus anonymous id printed by `/feedback`.

## Decision

Remove the capability wholesale (X04 of the wave-4 absorption):

- `session-telemetry`, `session-telemetry-otel`, and `anonymous-user-id` are deleted from the tree; the base bundle row, its OTel dependencies, and every launch seam (`DSH_TELEMETRY_*`) go with them. Nothing reads those variables now.
- Both `llm-deepseek` protocols stop sending `x-deepseek-harness-user-id` and `x-deepseek-harness-session-id`; the request-boundary compaction marker `x-deepseek-harness-compact` stays. Header-absence tests cover both protocols, including a request that names a session.
- `/feedback` acknowledges with the session id only — no anonymous user, no sharing sentence — and no longer reads `ctx.get('sessionTelemetry')`.
- Docs, generated catalogs (config catalog, cordis catalog, api-catalog, module graph, capability seams, event relations), knip, and the type-equivalence manifest no longer mention the seam.

This note supersedes [telemetry default-off](2026-08-10-telemetry-default-off.md), [feedback-gated session telemetry](2026-08-05-feedback-gated-session-telemetry.md), [web telemetry default mount](2026-07-31-web-telemetry-default-mount.md), and [session-telemetry-otel revival](2026-07-23-session-telemetry-otel-revival.md); those notes remain as the design history of the removed capability.

## Alternatives considered

**Keep the seam dormant with no backend.** Rejected: an unmounted seam with env switches and identity plumbing is exactly the surface the retirement removes; dormancy still advertises a capability nothing exercises.

**Drop only the OTel backend, keep the seam and anonymous id.** Rejected: with no backend and no disclosure the seam has zero consumers, and the anonymous id existed to correlate telemetry (its last two consumers were the headers and the feedback acknowledgement, both removed here).

## Consequences

Session telemetry cannot be re-enabled by configuration; reintroduction means restoring packages, bundle rows, and env seams from history. `/feedback` no longer creates `$DSH_HOME/.anonymous-user-id`, and existing id files become inert. Deployments that relied on `x-deepseek-harness-*` identity headers for gateway routing must stop keying on them. The capability given up: opt-in OTLP export of session records for deployments that wanted it.

## Tests

`pnpm exec vitest run packages/feedback/command-feedback/tests packages/llm/llm-deepseek/tests packages/bundle/base/tests` — feedback ack shape, header absence on both protocols, base composition without the row. `pnpm run verify-config-catalog`, `verify-cordis-catalog`, `verify-api-catalog`, `verify-cordis-api`, `verify-module-graph`, `verify-translation-pairing`, and `verify-agent-note-format` cover the regenerated artifacts.
