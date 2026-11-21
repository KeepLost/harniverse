# Agent Note: Peer subagent provider — the pairing channel as an out-of-process backend

Status: implemented

English | [中文](2026-11-22-peer-subagent-provider.zh.md)

- Date: 2026-11-22
- Milestone: peer pairing roadmap M8 (narrow charter)
- Packages: `packages/subagent/subagent-peer` (new), `packages/peer/peer-client` (shared helpers), `packages/peer/tool-peer` (refactor to shared helpers)
- Review artifacts: PR #331

## Problem

A deployment paired with another Harniverse instance could expose it to its model only through the dedicated `peer` tool: the ordinary `subagent` seam — with its uniform tool wording, `subagent/start|end` observability, and fail-loud capability gating — had no transport that runs a child on the paired instance.

## Decision

The pairing channel becomes a subagent transport: `dsh-subagent-peer` registers the `peer` provider on `ctx.subagents`, and each delegated run is one fresh session on the single configured paired instance (`peerTarget`: exact instance id or display name, resolved per run). The owner approved the narrow charter (D20) after the scheduled-delegation withdrawal established the composition-coverage gate; every feature decision below follows "the provider is a consumer of the peer seam, never an extension of it".

## Why one-shot, and why that is honest

The seam's continuable path materializes LOCAL child sessions — the continuation manager owns Agent creation and turns, and `prepareContinuable` contributes only seed data — so a remote deployment cannot host continuable children at all. Rather than redesigning the continuation manager, the provider mirrors the established out-of-process shape (ACP/Codex/Claude Code): one-shot `start()`, `NO_START_CAPABILITIES`, and the service's own loud rejection for continuable requests ("no prepareContinuable capability"). The tool row mounts with `backgroundMode: 'one-shot'` (D21; the seam's fail-loud rule covers every capability request).

The single `peer/delegate` RPC both submits the prompt and awaits its first settlement, so `start()` resolves with an already-terminal result: publication is the wire readback, `dispose()` has no local work, and only transport or pre-publication-cancellation failures reject `start` (D22/D24). The run id IS the peer session id — unique across the pairing and continuable through the `peer` tool — which is the one thing ACP's process-scoped ids cannot offer (D23 in its implementable form: continuation lives on the peer tool, not the subagent seam).

## Capability boundaries recorded at design time

- D21 — no parent-enforced capabilities: the remote composes itself; the service rejects `outputSchema`/`maxDepth`/`toolFilter`/`persona` requests before any wire call.
- D22 — owner-configured targeting: `peerTarget` lives in the provider config (deployment composition), never in the model-facing tool schema; the model picks nothing but the prompt.
- D24 — cancellation is local-abandon only: a pre-publication abort rejects `start` while the abandoned remote turn runs to completion and consumes its own budget; documented as a known limitation, no remote-abort wire.
- D25 — no artifact bridging: the subagent tool's prompt is text-only (non-text blocks reject before dialing); files keep flowing through the `peer` tool's upload/download facilities. The originally sketched "prompt files ride uploads" has no entry point in this tool schema.
- D26 — budget attribution unchanged: delegated turns consume the pairing's own governance (surface gates, turn budget, byte budget) exactly as manual `peer` calls do; no new accounting surface.

## Stop-reason mapping

The peer `endReason` IS the harness turn-end vocabulary, so shared reasons pass through (`completed`/`refusal`/`max-tokens`/`aborted`), unknown reasons flatten to `error` with the raw value as diagnostic, and a turn still `running` at the clamped settlement budget settles as `error` with a continuation diagnostic naming the peer session. A settled turn without an end reason counts as completed.

## Shared helpers extracted

`selectPeerTarget` (instance-id/display-name resolution with the active catalog) and `peerFailureMessage` (closed-reason wording) moved into `dsh-peer-client` and are now consumed by both `tool-peer` and the new provider — the selector semantics and diagnostics are byte-identical to the previous inline copies.

## Baseline repair in the same seam

The ACP loader e2e (`subagent-acp/tests/loader-composition.e2e.ts`) was red on HEAD and unwatched by any CI gate: the continuable migration turned the ordinary tool path into `invoke()`, which every one-shot-only provider rejects, and the fixture's assertion predated the legacy one-shot render. The fixture now pins `backgroundMode: 'one-shot'` and asserts the current render (Final output carries the cwd echo), restoring the suite to green locally.

## Testing and verification

- Unit (`tests/subagent-peer.spec.ts`, 15 cases): prompt admission (text-only/empty/oversized reject before dialing), settlement mapping including running-at-budget and unknown-reason diagnostics, transport-failure flattening with peer reasons, pre-publication abort and already-aborted rejection, target miss/ambiguity catalogs, service-level capability and continuable rejections, budget clamping, empty-`peerTarget` load failure. Statements/branches/functions 100% on package src (the impossible non-PeerError transport arm is ignored with a reason, mirroring `out-of-process.ts`).
- REAL composition (`tests/loader-composition.e2e.ts`): boots the headless app through the Loader with the test-only `cordis.yml`; the scripted parent model delegates once through the ordinary `subagent` tool to a scripted pairing target over real HTTP, and the session log asserts the legacy one-shot render publishing the peer session id with the settled reply as Final output. Mock-only composition, keyless tier (the peer channel's own cross-instance e2e lives in the peer suites).
- `dsh-peer-client`/`tool-peer` suites stay green after the helper extraction (205 peer-suite cases).

## Alternatives considered

- Redesign the continuation manager to host remote continuable children: rejected for the narrow charter — the manager materializes local child sessions by contract, and changing that ownership model is a seam redesign, not a provider.
- Local post-validation of `outputSchema` over the reply text: rejected — silent-degradation smell; schema enforcement belongs to the child's side, which the parent cannot control.
- A dedicated `peer-subagent` model tool next to `subagent`: rejected — a second model-facing delegation entry duplicating the seam's tooling and wording.
- Scheduled-delegation-style composition shortcuts: already withdrawn under the composition-coverage gate; this note's provider adds only what the `peer` tool structurally cannot offer (uniform addressing, standard run events, durable peer-session identity as the run id).

## Consequences

- A deployment can now offer one paired instance through the ordinary `subagent` tool with standard `subagent/start|end` observability (`local: false`), while continuation and files remain first-class on the `peer` tool — two tools, one seam, no duplicated orchestration.
- The narrow charter explicitly declines: continuable remote children (needs a continuation-manager redesign), remote cancellation (needs a wire decision), artifact bridging (needs an entry point). Each is recorded as a Known Limitation with its upgrade trigger.
- Provider names in docs/rosters now read `spawn`/`fork`/`acp`/`peer`/`codex`/`claude-code`/`dsh-sdk`.
