# @deepseek-ai/dsh-client-session-reading

English | [中文](README.zh.md)

Per-session reading memory behind the session rows' unread marker. A session that completes a turn while nobody is looking at it reads as unread; the marker clears once a reader demonstrably saw the completed turn, and the row menu can set or clear it by hand. One record per session lives in Host memory and is shared by every browser, device, and principal of that Host, so two browsers opened on the same Host agree on which sessions are unread. The package has two faces: the Host half keeps the ledger and serves it through the `sessionReading` Remote, and the browser half publishes it as the optional `useSessionReading` root hook. [ui-workspace](../ui-workspace/README.md) renders the marker and reports what the session list shows.

## Host ledger

`SessionReadingService` (`ctx.sessionReading`, the package's default export) keeps one record per session: `{ sessionId, completedTurn, failed, readTurn, manualUnread }`. Durable `turn/end` events advance it: every settlement on the `session/event` stream sets `completedTurn` to that turn and `failed` to whether the reason kind is `error`. Restored and seeded history never passes through that stream, so opening an old session arms nothing. Turn numbers grow inside one log; a settlement at or below the recorded turn means the id now carries another log, and the record starts over from that turn.

A record is unread exactly when `manualUnread || completedTurn > readTurn`. Records are never pruned: one whose session is deleted stays until the Host exits, where it is inert because no row names it.

## Remote

- `sessionReading.list()` (capability `harniverse.observe`) returns frozen copies of every record.
- `sessionReading.mark(sessionId, 'read' | 'unread')` (capability `harniverse.operate`) applies one reader action. `read` sets `readTurn` to `completedTurn` and lowers a manual mark; `unread` raises the manual mark and creates the record when the session has none. A session already carrying the requested state returns its stored record and announces nothing; `read` for a session without a record returns `{ record: null }` and stores nothing. The Remote keys records by id and does not check that the session exists.

After every stored change the service emits `sessionReading/changed` with an empty payload. [api-remotes](../../api/remotes/README.md) forwards that event, and consumers re-read `list()`, which stays the authoritative ledger.

## Browser half

The plugin injects `slots`, `sessions`, `remote`, and `remote.sessionReading`. Its `SessionReadingController` is a React-free object layer: it fetches the ledger once, re-reads it on the forwarded `sessionReading/changed` event and on `connection/reset`, collapses calls that arrive during a fetch into one trailing fetch, and keeps the last mirror when a read is refused or breaks (it warns in the console). `apply` publishes the controller through `ctx.slots.provideRoot({ hooks: { sessionReading } })`, which the renderer binds into the `useSessionReading` root hook. That hook is an optional member of the global standard props: a composition without this plugin — the assembled jsdom snapshots, a Host that mounts no reading row — renders session lists unchanged, so consumers must tolerate its absence.

`useSessionReading(selector)` selects over `{ unread, mark, report }`. `unread` holds one entry per unread session keyed by id, each carrying only the `failed` bit; an absent key reads as up to date. `mark(sessionId, action)` sends a reader action from the row menu. `report(sessionId, rowVisible)` is how the session list states whether it currently renders one session's row.

### Acknowledgement

The controller sends `mark(sessionId, 'read')` on its own only while every attention fact holds at once:

- the document is visible and holds the window focus (`document.visibilityState === 'visible' && document.hasFocus()`);
- the session is the current selection (`ctx.sessions.list`);
- the list reported its row as rendered, and has not reported it hidden since;
- the transcript shows the turn the ledger credits: the session's conversation snapshot holds that `turn/end`, or, for a session that completed no turn since the Host started, its window finished loading.

The facts are re-evaluated whenever one moves, so a completion that lands while the reader is already looking is acknowledged as soon as the new turn renders, and a selection whose history has not arrived yet is left unread. One acknowledgement per session is in flight at a time; a refused or broken one is retried on the next attention change, and every landed mark re-reads the ledger.

A manual unread is held: a record carrying `manualUnread` that arrives while its session stays selected is never acknowledged automatically, whether the mark came from this page's row menu or from another browser. Leaving the session releases the hold, and returning to it reads it like any other completion.

## Model Experience

None, as the reading ledger is Host view state and its Remote never enters a prompt, tool schema, or session event.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Records live only in Host memory** — a Host restart drops every record, so no session reads as unread until its next completion on the new process. The upgrade path is a persisted record per session in a storage domain, keyed by session id.
- **A row counts as read when it is mounted, not when it is scrolled into view** — the session list reports whether it renders the selected row; a mounted row outside the scrollport still counts.
- **A refused manual mark is logged, not surfaced** — the row keeps its marker and the console carries the reason.
- **The transcript check reads the conversation snapshot, not the DOM** — a conversation view that mounts the selected session but hides its transcript still counts as reading it.
- **Acknowledgement names the session, not the turn** — a turn that settles while a `mark('read')` call is in flight is acknowledged together with the turn the reader saw.
