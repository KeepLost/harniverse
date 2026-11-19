# Agent Note: Peer delegation over the pairing channel

Status: implemented

English | [中文](2026-11-18-peer-delegation.zh.md)

## Problem

Pairing (PR #324) pins two homes' identities but carries no task traffic: a paired initiator cannot start sessions on the target, deliver follow-up turns, or enumerate what it owns, and the M1 hello trusts invitation possession plus registry name-uniqueness because the Remote boundary cannot see the calling principal. Delegation must not widen the single `harniverse.peer` capability, must scope every operation to the calling peer's own sessions, and must keep delegated sessions out of user-facing session lists.

## Decision

Every `peer/*` request beyond pairing now carries a cryptographic proof. `peer/challenge` mints a single-use nonce; `peer/hello` requires a P-256 signature over `(instanceId, nonce)` and pins the verifying key as `identityPublicKey` in the peer record — later hellos verify against the pinned key, closing the record-hijack window. `peer/delegate`, `peer/followup`, and `peer/sessions` carry timestamp-windowed request proofs (`peerRequestMessage`, `PEER_PROOF_SKEW_MS`) verified against the pinned key; the host resolves the calling record from the proof itself, then gates on the matching `PeerSurface` field.

Delegated sessions are ordinary agent sessions composed through the same service seams the API proxy uses — `ctx.get('agents')` create/resume with the deployment's default model selection and optional `agentPresets` profile — tagged `origin: 'peer'` with working directories rooted under `peer-work/<instanceId>/` (relative request paths only). Prompts deliver through `agent.followup`; settlement observes the session's own public event window (`session.eventsFrom`) raced against the requested budget, returning concatenated assistant text and the turn-end reason, or `state: 'running'`. The session-header origin union widened from `'subagent'` to include `'peer'`, and every user-facing list filter (`session.list`, cold lists, ordinary-session visibility in the API proxy) now admits only `origin === undefined` rows, so peer sessions stay reachable solely through the peer Remotes. `peer-sessions.json` under the target home is the delegation registry; `removePeer` drops the peer's entries and closes resident agents from true idle.

## Alternatives considered

- **Ride the subagent continuable seam** — rejected: continuable children require a live parent Agent and package-private host hooks; a peer has no local parent session on the target.
- **Mirror the chat bridge (API-level client with an internal operate grant)** — rejected: it would mint a second, wider credential and depend on a listening webserver; in-process service seams need neither.
- **Per-call challenge nonces instead of timestamp windows** — deferred: one extra round trip per call for a replay window this narrow; the pairing hello keeps the full single-use challenge.

## Consequences

Wire failures now carry the closed peer reason through `RemoteError` code `peer-failed` (`details.reason`), a registered code in the API proxy's error vocabulary — the M1 behavior of collapsing every server-side rejection into a transport fault is gone. The origin union widening touches core session validation, both persistence formats' validation, the API proxy wire schema, and the client contract; any future origin value must update all of them plus every `origin === undefined` visibility check. Timestamp-windowed proofs admit a capture-replayed call inside the skew window; the CLI's synchronous call pattern makes this low-value. The five-mirror capability lesson from M1 gains a sixth surface: the `peer-failed` wire code.

## Required verification

Real Loader compositions in `packages/peer/peer-host/tests` (challenge/hello pinning, delegate/followup/sessions over a scripted agent registry, surface denials, proof failures) and `packages/bundle/peer-app/tests` (CLI end-to-end: invite → add → run → sessions → send over real HTTP with real grant exchange), per-file 100% coverage on the three peer packages, and the affected suites for session, persistence, API proxy, and client runtime.
