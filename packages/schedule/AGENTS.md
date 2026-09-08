# AGENTS.md — Schedule packages

These rules supplement the repository and package instructions for `packages/schedule/*`.

- The owning Session's versioned `schedule/change` stream is the only durable Schedule state. Folds validate every durable JSON boundary and derive active records; timers, idle waiters, and tool values remain disposable projections.
- A normal Session folds its complete log. A fork derives active Schedule state only from events at or after `SessionHeader.seedLength`; it never inherits an active parent reminder.
- Every Schedule management operation that reads or decides from the fold first awaits `ctx.sessions.flush(session)`. Create and an actual delete await a second barrier after append; a failed barrier returns the stable uncertainty result instead of inferring durability from the live log.
- Runtime owners attach only to future live root Agents while the plugin is loaded. They do not scan persisted Sessions, adopt already-published roots, wake cold Sessions, register global tools, or delete durable records during teardown.
- Due handling rechecks the wall clock and exact live owner, claims the idle maintenance phase through the public Agent seam, constructs the complete escaped framing before `followup()`, appends dispatch only after synchronous enqueue returns, releases maintenance, and then awaits durability. A synchronous framing/enqueue failure appends no dispatch; a later model failure does not roll one back.
- Rule math and durable transition logic stay pure and deterministic. Production uses the platform wall clock and segmented timers; tests supply explicit samples or fake timers without adding a production clock service.

## `scheduler` (downstream, `dsh-scheduler`)

The downstream host-level scheduler differs from the upstream `schedule` package on purpose; the upstream rules above bind only `packages/schedule/schedule`:

- One central `storage-domain` table is the only durable scheduler state; session logs record only the log-only `schedule/dispatch` provenance event and the delivered plugin-source `user/message`.
- Delivery targets ordinary sessions: live roots through the idle maintenance phase, cold sessions through the session-delivery-local resume sequence, job targets through one lazily created, forever-reused ordinary session.
- Rule math stays pure in `src/time.ts`; production uses the platform wall clock, and tests supply fake timers without adding a production clock service.
- A failed one-shot retries after ten minutes with `lastError`; a failed recurrence advances to its next slot. Advancement follows the delivery attempt, so a crash replays at most one dispatch per due slot.
