# Agent Note: The initiator settlement ledger

Status: implemented

English | [中文](2026-11-19-peer-outbox.zh.md)

## Problem

The peer tool (PR #326) made delegation model-reachable but synchronous within the budget: a turn running past it returned manual re-check guidance, an unreachable target failed the call, and nothing watched accepted turns to completion. The owner ruled the reliability shape: pairing is a both-online contract — an unreachable target must fail immediately, and no deferred resurrection may ever run work at an unanticipated moment, because an expected failure is safer than an unexpected later success.

## Decision

Split settlement tracking from submission as three narrow pieces, each owned by its existing seam:

- **`peer/result` Remote** (`dsh-peer-host`): a read-only settlement read gated on the `list` surface. It re-derives one owned turn's terminal state, reply, and end reason from the live session log — or the persisted events of a cold session — so settlement reads never require another model turn. `dsh-peer-client` gains the symmetric `runPeerResult`.
- **`dsh-peer-outbox` service** (`ctx.peerOutbox`, storage-domain ledger `peer_outbox`, web-app composition beside `peer-host`): tracks exactly the turns an online target already accepted but that outran the tool budget. The instance-resident poller reads every watching entry through `peer/result` per poll interval. A transient transport fault gets exactly one immediate re-probe; a second fault fails the entry `TARGET_UNREACHABLE`. The ledger holds no unsent work, has no retry queue, and waits for no one. A settled turn delivers its truncated reply into the initiating session as one `peer`-sourced queued user message through the idle maintenance phase (the scheduler's delivery pattern), in submission order per owner session; a closed session fails `OWNER_SESSION_NOT_LIVE` with the reply retained in the ledger. Terminal entries are pruned beyond 200.
- **Tool and CLI upgrades** (`dsh-tool-peer`, `dsh-peer-app`): the tool registers running turns with `ctx.get('peerOutbox')` when the service is composed (deployments without it keep the M3 guidance verbatim) and points the model at the queued delivery; `dsh peer run/send --async` submit with the minimum budget and print the receipt, `dsh peer result` is the manual settlement read behind any receipt, and `dsh peer outbox` is the ledger's read-only view through the same storage composition the instance writes with.

The ledger belongs to the home, not to a process: the CLI's `--async` deliberately does not write it (the instance is the single domain writer), and an instance restart resumes every watch from the durable store on its next poll.

## Alternatives considered

- **Retry queue with backoff until the target returns** — rejected by the owner's ruling: it is precisely the deferred-resurrection semantics that make work fire at unanticipated moments.
- **peer-app as a second poller host** — rejected: instance-to-instance is the product shape (DSH_HOME is the instance), and a second polling implementation would duplicate recovery semantics; the CLI keeps manual `result` reads instead.
- **Cold-session resume delivery** (the scheduler's full cold path) — deferred with M6: waking a closed session runs a local model turn at a moment the user did not choose, which leans toward the same unexpected-consequence family; the reply stays inspectable in the ledger.
- **Extending `peer/sessions` with reply bodies** — rejected: list responses would carry unbounded bodies; a dedicated per-turn read keeps the boundary explicit.

## Consequences

- The outbox's failure families are closed and inspectable (`dsh peer outbox`): `TARGET_UNREACHABLE`, `TARGET_RECORD_NOT_FOUND`, `SESSION_DROPPED`, `OWNER_SESSION_NOT_LIVE`, `READ_FAILED`.
- A crash between delivery and the settled write replays one delivery per entry; the reply content is idempotent and the window is bounded by the session flush barrier.
- `dsh peer outbox` reads the durable JSON medium from a second process; it never writes, and single-writer discipline stays with the running instance.
- Deliveries target live agents only, in per-session submission order; cross-cycle ordering between different sessions is not guaranteed.
- `peer/result` re-derivation fails closed (`SESSION_NOT_FOUND`) when the claim fell out of the resident suffix and persistence holds no events — a bounded edge documented in the package README.

## Required verification

- `packages/peer` vitest group: `peer-outbox` unit suites (delivery, every failure family, FIFO, crash-recovery restart, retention pruning, mid-cycle disposal, 100% statement and branch coverage on `src/`), a real Loader composition proving ledger durability across restart, `peer-host` result Remote suites, `runPeerResult` client coverage, tool tracking with and without the outbox service, and the CLI `--async`/`result`/`outbox` paths through the Loader-booted composition.
- `pnpm run test:snapshot` keyless replay after refreshing the ACP scenarios (tool description and peer-host wire surface changed).
