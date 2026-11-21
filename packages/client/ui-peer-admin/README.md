# `@deepseek-ai/dsh-client-ui-peer-admin`

English | [中文](README.zh.md)

The Web governance surface for paired Harniverse peers. It contributes the dashboard 配对同伴 tab over the generated `peer` Remote contract's owner-administered verbs, refreshed live by the forwarded `peer/paired` and `peer/removed` host events.

The tab lists every paired peer with its identity, last-seen time, granted surface, pending surface requests, monthly turn and artifact-byte budgets, and delegated-session count. The owner edits the granted surface directly (four grant toggles; an owner decision needs no approval step), approves or rejects a peer-requested widening parked as a pending surface, sets or lifts a per-peer monthly delivered-turn cap together with a monthly artifact cap entered in MiB (metered in bytes on the host), audits a peer's delegated sessions as metadata-only rows (live state, last activity, creation label — transcripts stay in the normal session view), and removes a peer through an explicit confirm step. Removal ends the peer's delegated sessions and drops its governance entry; the paired side learns of the removal when its next call fails to resolve the record.

Closed peer wire reasons — `RECORD_NOT_FOUND`, `INVALID_PAYLOAD`, `STORE_FAILED`, `CORRUPT_INSTANCE` — surface as localized operator copy instead of raw messages, and budget input is validated client-side against the same 1..1,000,000 integer bound the host enforces.

## Model Experience

None, as this browser-side management surface only exposes authenticated operator actions and registers no model context, tools, events, or request fields.

#### KV Cache effect

No direct effect. The tab does not change model request prefixes.

## Known Limitations and Deferred Work

- The audit rows are metadata only by design: reading a delegated session's transcript stays in the normal session view, and no transcript text crosses the admin Remote.
- Budget usage counts accepted delivered turns; a capped peer's in-flight turns can still overshoot the cap by the number of concurrently running deliveries, which the host documents as the at-most-in-flight overshoot.
- A peer's pending surface request has no expiry: the single pending slot is replaced by each newer widening request and clears on approval, rejection, owner edit, or a peer-side narrowing commit.
