# Agent Note: Peer governance — approval flow, budgets, audit, and the admin surface

Status: implemented

English | [中文](2026-11-21-peer-governance.zh.md)

## Problem

The pairing fabric left the accepting side ungoverned: surface changes had no approval flow (debt #7), the `peer/paired` / `peer/removed` events had no consumer (debt #8), and nothing bounded a paired peer's delegated turn volume. The owner ruled on the roadmap's decision points: D11 = c (audit lives as a metadata-only per-peer session list inside the peers tab; transcripts stay in the normal session view, retention is the pairing's lifetime), D13 = a plus reject (pure narrowing commits immediately; any widening parks for owner approval; nothing queues; the pending slot carries no TTL — the latest request replaces the older one, which bounds state without a timer), D14 = b (hard budget counted in delivered turns, monthly, default unlimited).

## Decision

Four pieces, each owned by its existing seam:

- **Owner governance Remotes** (`dsh-peer-host`): `list`, `remove`, `setSurface`, `approveSurface`, `rejectSurface`, `setBudget`, `audit` join the `peer` namespace behind the `harniverse.administer` capability — peer wire tokens cannot reach them. `list` answers `PeerAdminView` rows (identity, surface, pending surface, budget usage, session count) newest-activity-first; `remove` reuses the existing removal path (sessions ended, `peer/removed` emitted) and additionally drops the governance entry; `audit` answers the peer's session summaries, metadata only.
- **Surface approval flow** (`dsh-peer-host` + `runPeerSurface` + `dsh peer surface`): the peer-wire `surface` Remote takes one complete desired surface. A pure narrowing (or an equal surface) commits on the spot and retires any parked request — narrowing is the peer surrendering grants, so the parked widening is stale the moment a newer complete desire narrows. Any widening parks the complete desired surface in the record's single `pendingSurface` slot (durable in `peers.json`, additive optional field; latest request wins, no expiry). While a request pends, every family answers under the surface in force — no call queues, no partial grants. The initiator CLI prints `committed` or `pending owner approval` with the surface still in force.
- **Turn budgets** (`dsh-peer-host/src/governance.ts`): `peer-governance.json` holds one optional per-peer monthly cap counted in accepted delivered turns — `delegate` first turns and `followup` turns alike — in UTC calendar months (`YYYY-MM`), unlimited when unset, retention pruning to the current plus previous period. The gate runs before delivery: a capped `delegate` mints no session or working directory, and a capped `followup` checks before the session lookup so a capped peer learns nothing about stored ids. The count is recorded once the turn is accepted for delivery — whatever its settlement later says — so concurrently in-flight deliveries can overshoot by at most their own count, which the READMEs document as the at-most-in-flight overshoot. The rejection is the closed reason `BUDGET_EXCEEDED` naming the period and limit.
- **Admin consumption** (`dsh-client-ui-peer-admin` + `api/remotes`): the generated peer Remote client mounts into the client assembly, `peer/paired` / `peer/removed` join the forwarded-event allowlist, and the dashboard's 配对同伴 tab renders the roster with inline surface toggles, approve/reject actions on parked requests, budget set/lift with the same 1..1,000,000 bound the host enforces, the metadata-only audit expansion, and confirm-step removal. A registrant-private observable tick in the inject `hooks` compartment re-lists the roster on every forwarded pairing event — the sanctioned channel for a reactive fact the renderer binds.

Removal intentionally announces nothing on the event stream: the paired side discovers a removal when its next call fails to resolve the record, which the outbox already treats as a normal failure family.

## Alternatives considered

- **Audit inside the session list (D11 = a/b)** — rejected: delegated sessions already appear in the host's session list as ordinary sessions, so hiding or collapsing them there would change existing UI behavior to add a governance view; a per-peer metadata list inside the peers tab gives the owner the audit trail where the governance actions already live, without touching the workspace tree.
- **TTL on pending surface requests** — rejected: expiry trades a timer and a new durable field for state the single-slot replacement already bounds. A parked request is one record field, replaced by each newer widening and cleared by any owner decision or peer-side narrowing; an unbounded queue never forms.
- **Queue calls while a widening pends (D13 queue arm)** — rejected: it re-imports M4's reversed semantics (unpredictable late success) through the back door. Pending applies to the request, never to calls; denial stays immediate and legible.
- **Token-count budgets** — deferred: token estimates need a model-coupled estimator the fabric does not own; delivered turns are exact, available today, and match the unit the ledger already counts.
- **SSE notice frame on removal** — rejected: the stream is a wake channel for settlements; a removal frame would make channel state a second authority for pairing state. The failing next call is already a closed, classified failure.
- **Owner-only UI gating by capability introspection** — rejected: the administer capability already gates the Remotes; the tab renders for everyone and a non-owner sees the carrier's denial as localized copy, which is how the remote-hosts tab behaves today.

## Consequences

- `PeerRecord` gains the additive optional `pendingSurface` and the store parser accepts it (store version stays 1; the shape stays closed). `peer-governance.json` is a new owner-only store in the accepting home. Both are documented in the peer subsystem page and the host README.
- The typert contract for the `peer` namespace now covers sixteen methods across two capabilities; the golden test asserts the split (`harniverse.peer` for the wire families, `harniverse.administer` for the governance verbs).
- The event-forwarding allowlist (`API_REMOTE_FORWARDED_EVENTS`) gained exactly two entries; consumer `ctx.remote.$on` faces gain them automatically, and the producer/consumer matrix now shows `apiproxy` listening on both events — debt #8 is closed.
- Budget accounting is per accepting instance; an initiator multi-homing across targets consumes each target's budget independently, which matches the fabric's identity model (pairing is per-home, per-direction).
