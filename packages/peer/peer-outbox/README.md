# @deepseek-ai/dsh-peer-outbox

English | [中文](README.zh.md)

Initiator-side settlement ledger for instance pairing: tracks delegated turns an online target already accepted but that outran the calling tool's budget, polls their settlement read-only, and delivers the settled reply into the initiating session as a plugin-sourced user message.

The ledger holds no unsent work and retries nothing. Pairing is a both-online contract: a target unreachable during settlement fails the entry after exactly one immediate re-probe, per the owner's ruling that an expected failure is always safer than an unexpected later success. The peer tool registers running turns here when the deployment composes this service; `dsh peer outbox` lists the ledger for inspection.

## Service surface

- `ctx.peerOutbox.track(input)` — durably register one accepted-but-running turn; an instance restart resumes the watch on its next poll.
- `ctx.peerOutbox.list()` — every entry, earliest submission first.

Each poll cycle reads every `watching` entry's settlement through the read-only `peer/result` Remote (`harniverse.peer` capability, `list` surface). A settled turn delivers its reply (truncated at `maxResultChars`) through the idle maintenance phase as a `peer`-sourced user message; a terminal entry keeps its outcome in the ledger, and at most 200 terminal entries are retained. Failure families are closed: `TARGET_UNREACHABLE`, `TARGET_RECORD_NOT_FOUND`, `SESSION_DROPPED`, `OWNER_SESSION_NOT_LIVE`, `READ_FAILED`.

## Configuration

- `dshHome` (required) — Harness home holding the pairing target store and the storages root.
- `pollIntervalMs` (default 30000, minimum 100) — poll cadence for watching entries.
- `maxResultChars` (default 50000) — stored and delivered reply ceiling.

## Events

None. The storage domain emits `domain/changed` after each acknowledged ledger write; the service owns no independent event history.

## Verification

`packages/peer` vitest group: unit suites cover delivery, failure families, FIFO per owner session, crash-recovery restart, retention pruning, and disposal; a real Loader composition boots the storage stack and the service and proves ledger durability across restarts.

## Model Experience

### Receiving a settled delegation

#### What the model sees

When the peer tool reports a still-running turn, the settled reply later arrives as one queued user message naming the target, the terminal status (`completed` or `ended <reason>`), the peer session id, and the truncated reply text. A model whose earlier turns were compacted away can still act on the outcome without the original tool call.

#### Token effect

One user message per settled turn; the reply is truncated at `maxResultChars`, bounding the tokens one delegation can add to a session.

#### KV Cache effect

The message arrives between turns as ordinary user content, appended after the previous turn's messages; it never rewrites prior content, so the cached prefix stays valid.

## Known Limitations and Deferred Work

- Delivery targets live agents only: a session that is closed or cold when its entry settles fails with `OWNER_SESSION_NOT_LIVE` and the reply stays in the ledger for `dsh peer outbox`; cold-session resume delivery is deferred with the M6 governance work.
- A crash between delivery and the settled write replays one delivery per entry (the reply is idempotent); the window is bounded by the flush barrier.
- The `dsh peer outbox` view reads the durable JSON medium from a second process; entries written by a running instance appear once their write completes, and the view never writes.
