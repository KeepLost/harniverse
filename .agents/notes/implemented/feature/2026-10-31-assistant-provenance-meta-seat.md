# Agent Note: Per-message provider/model provenance line

Status: implemented

English | [中文](2026-10-31-assistant-provenance-meta-seat.zh.md)

## Problem

The chat transcript showed nothing about which provider route and model produced each assistant reply, so a session that switched models mid-way (or resumed under a different route) left no visible per-message trace. The fact was already durable — every `assistant/message` event carries `message.source` (`ModelMessageSource`: provider, model), load-validated non-empty — and the runtime's `AssistantMessageNode` already had an optional `provenance` slot, but the chat folder never filled it (only the trajectory folder did, for its request-inspection panel), and no presentation seam existed for a per-message meta line.

## Decision

Fill, then seat:

- The chat assistant folder's event-backed `finalNode()` fills `provenance: { provider, model }` from `event.data.message.source`, identically to the trajectory folder. The synthetic interruption node (no finalized message event) carries none.
- `conversation.chat.assistant.meta` — a single/session seat declared by the `assistant-step` chat-node entry (declaring is claiming), owner share `AssistantMetaOwnerProps = { provenance }` (plain data). The shipped occupant renders `provider · model` at priority 100 as a quiet 11px tertiary attribution line under the message body; a lower-priority registration presents the same identity its own way, and disposal restores the shipped label.
- Placement belongs to the render site (AssistantMarkdown renders the seat output in a `.meta` footer line); copy belongs to the occupant — the same site/occupant split as the sibling seats. Without a threaded seat the plain ids render directly (the gallery/body fallback pattern).
- The render site stays silent while the identity is unknown: streaming rows (no final node yet) and synthetic interruptions label nothing. Zero host, protocol, or session-format change — the v0 event already carries the data, and the contract digest is untouched.

## Alternatives considered

**A fixed inline label without a seat.** Smallest diff, but not replaceable, and against the presentation-seat pattern the row-7 seats established for exactly these domains.

**A turn-tail chrome label.** Turn granularity mislabels multi-step turns and mid-turn model switches; the requirement was per message.

**Host-side changes (a new projection or event field).** Unnecessary: the identity is already durable per message; new surface would carry zero information gain (the contextPressure projection discarding provider/model is the cautionary mirror).

**Session-level display (stats dock or the model seat).** Expresses the current or next route only; history in a multi-model session cannot be attributed session-level.

## Consequences

- Every finalized assistant message — including event-backed interruptions — gains a visible attribution line, so the assembled browser goldens changed; all affected golden files were refreshed in the same change (the only textual shape change: each settled row gains a `text: provider · model` entry, adjacent to the stopped marker when interrupted).
- A third party hides or restyles the label by registering below priority 100; disposal restores it. The client slot catalog regenerates with the new seat.
- Verification: folder provenance assertions (settled fill from a distinct source; synthetic interruption stays undefined); seat-occupant, bridge, silent-while-unknown, and registry benches (priority 100, dispose-restore, fiber teardown) in the presentation-seats suite; `pnpm run gen-client-catalog`; changed-file oxlint clean; `pnpm run typecheck`; `pnpm run test:gui`; `pnpm run test:snapshot` replay; web e2e goldens refreshed under `DSH_SNAPSHOT=refresh` and spot-replayed green.
- Relationship: extends the row-7 seat family ([2026-10-30 row-7 seats](2026-10-30-row7-presentation-seats.md)); the trajectory request-inspection display ([2026-09-16 trajectory request context](2026-09-16-trajectory-request-context.md)) remains the request-level view, while this note owns the per-message chat line.
