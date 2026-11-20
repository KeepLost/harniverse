# Agent Note: Peer event channel, cancellation, and transport pinning

Status: implemented

English | [中文](2026-11-20-peer-event-channel.zh.md)

## Problem

The M4 settlement ledger senses settlements by blind polling, and both security debts the pairing review left open — the ±90s capture-replay window on request proofs and the raw sdk-client error on re-pairing against a revoked grant — trace back to the channel not being settled. The owner ruled on the roadmap: D8 = b (SSE, upstream stays on HTTP; pairing traffic is low and both instances keep executing independently, so the channel serves downstream push only), D9 = a (cancel the current turn only), D10 = b (enforce the TLS pin on direct and SSH-forwarded dials).

## Decision

Six narrow pieces, each owned by its existing seam:

- **Nonce-bearing request proofs** (`dsh-peer-protocol`): `PeerRequestProof` gains a single-use `nonce`; the canonical signed message becomes `dsh-peer-request/2:<instanceId>:<timestamp>:<nonce>`. `verifyPeerRequestProof` returns the nonce and the host's `PeerNonceLedger` consumes it on first use — a capture replayed inside `PEER_PROOF_SKEW_MS` answers `INVALID_PROOF (replayed nonce)`. Retention is bounded per peer (`PEER_NONCE_TTL_MS` horizon, 256-entry bucket); the bound is memory hygiene, not a security claim, and is documented as a limitation.
- **SSE event channel** (`dsh-peer-host`): `peer/subscribe` (proof-authenticated, `list`-gated) mints a single-use stream token; the exact route `GET /api/peer/events?token=…` — registered through `ctx.webServer.register({ kind: 'exact' })` whenever a web server is composed, exact routes taking precedence over the shared `/api` prefix — serves one `text/event-stream` per subscription. `turn/end` of the peer's own sessions pushes `{"kind":"settled","sessionId"}` frames; heartbeats flow at `PEER_STREAM_HEARTBEAT_MS` and refresh the owned-session filter. The unguessable single-use token is the route's entire authentication — no `client-connection` internals are touched, and every reconnect passes a fresh nonce-bearing proof. That is the channel's token-renewal answer: there is no long-lived token to renew.
- **Advisory push with a standing poll** (`dsh-peer-outbox`): one stream per watched target; every frame pokes an immediate poll (a frame landing mid-cycle defers to the next re-arm through the `again` flag). A refused subscription or a broken stream changes nothing — the standing `pollIntervalMs` cadence keeps watching, no entry waits for a target to come online, and M4's one-immediate-re-probe semantics are untouched. Settlement truth remains `peer/result`.
- **`peer/cancel`** (`dsh-peer-host` + `runPeerCancel` + `dsh peer cancel`): cancels the current turn of one owned, resident session (`delegate` surface). A running turn is aborted with the user cause and returns its terminal state; an idle session reports its newest claim's settlement unchanged; a non-resident session answers `SESSION_NOT_FOUND` — cancellation never cold-resumes sessions and never fabricates work.
- **TLS pin enforcement** (`dsh-peer-client`): `pinnedFetchFor` builds the transport fetch with an undici `Agent` whose `checkServerIdentity` requires the peer certificate to hash (base64 SHA-256) to the pinned `tlsFingerprint`; a pinned target dialed over plain HTTP fails `PIN_MISMATCH` before any bytes leave. SSH forwards accept `https://127.0.0.1:<port>` invitation endpoints so the same verification rides the tunnel end-to-end; unpinned HTTPS keeps Node trust roots.
- **Closed re-pair guidance** (`callPeerRemote`): Grant challenge/token exchange failures (`GrantAccess:` errors) classify as `EXCHANGE_FAILED` carrying the remove-and-re-invite guidance; transport-level throws classify as `TRANSPORT_FAILED` (`HELLO_REJECTED` during pairing), which also fixes the outbox failure family for real network refusals.

`PeerEventFrame` stays a closed one-member union (`settled`): every new frame kind is a wire-contract decision, not a free extension.

## Alternatives considered

- **WebSocket (D8 = a)** — rejected by the owner's ruling: nothing in M5's scope consumes a server-initiated upstream command, and WS would buy a state machine, backpressure, and an upgrade handshake to harden with no consumer. If true bidirectionality is ever needed (live workflow steps, say), a WS channel can be added beside this one — the channel is a plugin, and choosing SSE does not foreclose WS.
- **Channel-only nonce binding** — rejected as the sole replay defense: a per-request single-use nonce closes the window with or without a channel, needs no session state, and keeps one-shot RPC callers replay-safe too. The channel adds the push; the ledger closes the window.
- **Cancel the whole session (D9 = b)** — deferred: termination semantics entangle with the accepting-side governance work (M6); cancelling the current turn closes the initiator's loop without inventing lifecycle the fabric does not own yet.
- **Resumable stream (`Last-Event-ID`)** — rejected: a replay cursor would make the stream a second settlement authority. A dropped frame is covered by the standing poll; each reconnect mints a fresh token through a fresh proof.
- **TOFU pin recording on first dial** — rejected: a first-connection attacker would pin itself. The pin comes exclusively from the invitation payload.

## Consequences

- The stream route deliberately bypasses `client-connection`'s `/api` trust fence: a single-use unguessable token (minted only after a proof-authenticated RPC) is complete authentication for a side-effect-free read stream, and CSRF/DNS-rebinding have no leverage against it. Any future change to the route must re-evaluate this reasoning.
- Consumed-nonce retention is bounded per peer; a burst beyond the bound ages the oldest nonces out of replay protection inside the skew window (documented limitation).
- The pinned fetch verifies the certificate on every dialed connection but performs no certificate transparency or OCSP checks.
- Verification: the peer group's 155 tests cover nonce replay rejection, stream-token single-use/expiry/cap, heartbeat and ownership refresh, write-failure containment, route 403/200 handling, push-wake and teardown through a real scripted HTTP target, cancellation end-to-end through the real CLI composition, and pin verification; every touched `src` file across peer-protocol/peer-host/peer-client/peer-outbox/peer-app reports 100% statement and branch coverage; the typert golden is `['cancel','challenge','delegate','followup','hello','result','sessions','subscribe']`, all `harniverse.peer`.
