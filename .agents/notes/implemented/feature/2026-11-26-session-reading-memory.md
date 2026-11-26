# Agent Note: Per-session reading memory behind the session rows' unread marker

Status: implemented

English | [中文](2026-11-26-session-reading-memory.zh.md)

## Problem

The sidebar's reminder that a session finished while nobody was looking was Client-local state. The runtime watched each session's running bit fall while the session was unselected and set a `completed` bit on its list row; selecting the session cleared it. That made the reminder a property of one browser tab rather than of the reader: a second browser or device opened on the same Host never showed it, a reload forgot it, and it cleared the instant a row was selected even when the transcript had not loaded yet, so a reader who clicked through and moved on lost the marker without seeing anything. It also recorded only that a turn had finished — not whether it failed — and offered no way to flag a session by hand.

## Decision

Reading state belongs to the Host. [`@deepseek-ai/dsh-client-session-reading`](../../../../packages/client/session-reading/README.md) owns it in one package with two faces.

The Host face, `SessionReadingService` (`ctx.sessionReading`), keeps one record per session in Host memory: `{ sessionId, completedTurn, failed, readTurn, manualUnread }`. Durable `turn/end` events advance it through the `session/event` stream — no session event or wire frame is added — and a record is unread exactly when `manualUnread || completedTurn > readTurn`. Every browser and principal of the Host reads the same records. The Remote is unary: `sessionReading.list()` serves the records under `harniverse.observe`, `sessionReading.mark(sessionId, 'read' | 'unread')` applies a reader action under `harniverse.operate`, and every stored change emits the payload-less `sessionReading/changed`, which [`api-remotes`](../../../../packages/api/remotes/README.md) forwards through its allowlist so consumers re-read `list()`.

The browser face mirrors that ledger in a React-free controller and publishes it as the optional `useSessionReading` root hook through `ctx.slots.provideRoot`. The hook is an optional member of the global standard props: a composition without the plugin renders session lists unchanged, and consumers must tolerate its absence. [ui-workspace](../../../../packages/client/ui-workspace/README.md) is the consumer: it reads the unread rows for its status dots, offers the row-menu mark, and reports whether it currently renders the selected session's row.

The controller acknowledges a completed turn on its own only while four facts hold at once, each answering one way the old reminder went wrong. The document is visible and focused: a completion behind a hidden tab or window is not seen. The session is selected. Its row is reported as rendered by the session list: with the sidebar collapsed to the rail or a search replacing the list, the reader is not looking at the row. And the transcript shows the turn the ledger credits — the session's conversation snapshot holds that `turn/end`, or, for a session with no completion since the Host started, its window finished loading — so a selection whose history has not arrived yet stays unread. The facts are re-evaluated whenever one moves, one acknowledgement per session is in flight at a time, and a refused one is retried on the next attention change.

A manual unread is held rather than acknowledged: a record carrying `manualUnread` that arrives while its session stays selected is never cleared automatically, whether the mark came from this page's menu or from another browser. Leaving the session releases the hold, and returning reads it like any other completion.

The row presentation follows the ledger: an unread row shows the `done` dot labelled 未读, an unread row whose credited turn failed shows the `error` dot labelled 运行失败, live activity still outranks the marker, and the row menu toggles the mark. The runtime's Client-local `completed` bit is gone with the code that derived it.

The package is a split project under `packages/client/`: its Host leaf joins the Host aggregate so Typert generates the Remote contract, and its Client leaf joins the Client aggregate. [`packages/client/connection`](../../../../packages/client/connection/README.md) is the precedent for a client package with a Host half. Because the Client leaf consumes `api-remotes`' Client face while `api-remotes` mounts the generated `/remote` contribution, the latter declares the package as a devDependency only; a peer edge would close a cycle in the peer graph the generated module graph is ordered by.

The ledger lives in Host memory only. A Host restart drops every record, so no session reads as unread until its next completion on the new process; this is accepted. The upgrade path is a persisted record per session in a storage domain, keyed by session id, which the [`dsh-message-feedback`](../../../../packages/feedback/message-feedback/README.md) sidecar is the model for.

## Alternatives considered

**Keep the Client-local bit and synchronize it between browsers.** Rejected: reading state is a fact about readers, not about the session, so there is nothing durable to sync, and the Client cannot tell other browsers what this one has seen. Moving it to the Host is the whole decision.

**Persist the ledger now.** Deferred: it costs a domain spec, a schema, and a durability barrier on every acknowledgement, against a failure mode — a restart forgetting unread markers — that is bounded and self-healing. The record shape is already the persisted shape, so the upgrade adds a backend without changing the Remote.

**A streaming Remote `follow` for the ledger.** Upstream's session-status plugin streams per-session status; Harniverse Typert is unary-only, so that would need a new streaming transport. The unary `list()` plus the forwarded empty `sessionReading/changed` reuses the existing forwarded-event frame and keeps `list()` the single authoritative read.

**Make the root hook required and publish it from the runtime.** Rejected: the runtime would depend on the Remote and on the Host row, and every composition without the reading plugin — the assembled jsdom snapshots among them — would stop rendering session lists. An optional hook keeps the seam plugin-native.

**Acknowledge on selection alone**, as the old bit did. Rejected: it clears before the transcript arrives, which is exactly how a quick click-through lost the marker. The four facts cost one snapshot read per change and clear only what was shown.

**Treat any mounted conversation as reading.** Rejected: the controller cannot see the DOM, and "the turn is in the loaded window" is the evidence the conversation snapshot already carries. The session list, which does see its rows, supplies the row half of the evidence.

**Never acknowledge a manual mark automatically.** Rejected in favour of the hold: once the reader leaves the session and comes back, that is reading it. The hold still protects the mark for as long as the reader stays.

**A provider package under `packages/host/` and a consumer package under `packages/client/`**, which is how upstream splits Remote providers from their browser consumers. Rejected by the approved one-package design; its cost is the devDependency-only edge described above.

## Consequences

- Browsers and devices opened on the same Host agree on which sessions are unread, and a failed completion is distinguishable from a successful one at the row.
- Records are never pruned; a deleted session's record lingers inert until the Host exits.
- A row counts as read when it is mounted, not when it is scrolled into view, and the transcript check reads the conversation snapshot rather than the DOM.
- A refused manual mark leaves the row unchanged and reports the reason in the console only.
- `SessionSummary.completed` and `SessionListEntry.completed` leave the runtime's public contract; a consumer that rendered the old reminder reads `useSessionReading` instead.
- The governor quota tab mirrored the old reminder through an optional `completed` and lost its `done` dot; its rows show interaction and running only.
- The reading plugin is a second split Host/Client project under `packages/client/`, and `sessionReading/changed` joins the forwarded-event allowlist.
- A session-reading plugin that loads or unloads under a mounted session list remounts the list body; local state such as an in-progress search query resets with it.

## Testing

`packages/client/session-reading/tests/ledger.host.spec.ts` drives the Host service over a real session store: each durable settlement, the failure bit of the latest settlement, the restart on a reused session id, every mark outcome, frozen wire copies, and the change-signal count. `loader-composition.host.spec.ts` boots the service through a real Loader composition from a test-only `cordis.yml`.

`controller.client.spec.ts` covers the browser object layer over a fake Host ledger: the unread mirror and its stable snapshot, single-flight refetch, refused and broken reads, each missing attention fact, the live completion, the selection follow, the in-flight and retried acknowledgement, the manual hold from this page and from another reader, and disposal. `apply.client.spec.ts` mounts the plugin on a real Context and asserts the root hook, the forwarded signal, `connection/reset`, window focus and document visibility, and withdrawal with the fiber.

The ui-workspace tree, row, and browser specs assert the unread and failure dots with their labels, the row-menu mark, the row-visibility report across folded, overflow, search, flat, and rail states, and a browser that survives the seam appearing and disappearing. The runtime specs keep the list-refresh and selection behavior that the removed bit used to ride on. Every file of the new package, `tree.ts`, and `Rows.tsx` is under the per-file 100% coverage gate; the runtime and `WorkspaceBrowser.tsx` sit in the documented client GUI-debt exemption, where the added lines are covered.
