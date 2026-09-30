# Agent Note: Ownerless remote runtime exits instead of orphaning the home lease

Status: implemented

English | [中文](2026-09-30-ownerless-remote-runtime-exit.zh.md)

## Problem

A detached remote server holds the exclusive home lease for its lifetime. When the owning local instance dies ungracefully (crash, `SIGKILL`, machine loss), the server kept running: it no longer served its owner, yet it rejected every successor — a fresh local instance bootstraps a new client grant the running server never loaded, so its RPCs fail with `remote-hosts: REMOTE_RPC_REJECTED`, and exclusive home ownership blocks a fresh `startDetached`. The home stayed bricked until an operator killed the process by hand. Observed live: an e2e `SIGKILL` of the web stack left `/home/<user>/.dsh/server/.../node app/lib/bin.js --port 0` alive for a day.

## Decision

Owner liveness is a lease refreshed by authenticated RPC traffic, and the app turns lease expiry into a graceful self-exit.

- `dsh-remote-runtime` records `lastOwnerContact`, refreshed by every `@Remote` method (`status`, `unlock`, `replaceCredentials`, `syncSettings`). A watchdog ticks at `ownerlessExitMs / 5` (floor 50ms); when no owner RPC arrived within `Config.ownerlessExitMs` (default 45s), it emits `remote-runtime/ownerless` once per starvation episode. A later owner contact clears the episode and re-arms the next one — a server that boots uncontacted signals once, and still turns owned when its owner arrives.
- `dsh-remote-hosts` runs a session-scoped keepalive: after `establish` settles, the session calls `rpc('status')` every `heartbeatIntervalMs` (default 10s). The timer clears on session disposal and on SSH connection abort. Missed keepalives are swallowed — connection-loss detection owns failure reporting.
- The remote-server app subscribes to the event in its boot callback and sends itself `SIGTERM`, routing through the executable's existing graceful stop (tree disposal, endpoint withdrawal, lease release, 10s hard deadline). Detection stays in the protocol plugin; the exit action stays in the app.

Within the exit window a reconnect still fails fast with `REMOTE_RPC_REJECTED` (≤50s after owner death); a retry then succeeds through a fresh deployment. The prompt-rejection contract for a second concurrent live instance is unchanged.

## Alternatives considered

- **Idle TCP-connection watchdog** — rejected: HTTP keep-alive gaps would kill healthy idle sessions; heartbeats distinguish "connected but quiet" from "owner gone".
- **Takeover on admission rejection** — rejected: a rejected successor cannot distinguish a healthy foreign owner from an orphan, and killing a live server on an unauthenticated request is not acceptable.
- **Non-detached server tied to the SSH session** — rejected: it would trade the existing crash-resilient deployment design for teardown correctness.

## Consequences

An owner crash leaves at most one exit window (default 45s plus one tick) during which reconnects fail fast with the existing `REMOTE_RPC_REJECTED`; a retry after that window deploys fresh. A local instance that stays connected but silent still issues keepalives, so quiet sessions are unaffected. Operators upgrading remote artifacts gain self-healing homes; previously orphaned servers keep holding their lease until killed once by hand. The event vocabulary of the `remote-runtime` scope is now catalog-gated (`ssh.md` owns it), and both packages carry new validated config keys.

## Verification


`remote-runtime` unit specs cover starvation signaling, contact re-arming, and config bounds. A coordinator spec drives the full in-process scenario through the real fixture: heartbeats keep a connected runtime owned past its exit window, and owner death (connection abort) flips it ownerless. A real-machine e2e (web app + real sshd + rebuilt artifact) verified the exact user scenario: connect → `SIGKILL` the web stack → the remote server self-exited after ~50s → the restarted instance reconnected cleanly.
