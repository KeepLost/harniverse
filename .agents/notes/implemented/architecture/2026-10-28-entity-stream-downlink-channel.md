# Agent Note: Entity-stream downlink channel

Status: implemented

English | [中文](2026-10-28-entity-stream-downlink-channel.zh.md)

## Problem

Every per-entity browser stream family opened one long-lived HTTP connection per watched entity: `workspace.files.watch` per expanded directory (and per open editor document), `events.terminal` per followed terminal, `events.hold` per *running* terminal, `events.browser` per browser view — plus the page's two resident WebSockets (`events.mux`, `events.host`). Browsers cap a origin's HTTP/1.1 connections at roughly six **shared across tabs**. At four expanded directories the pool was full: every ordinary request (file reads, unary calls) queued forever behind the watches, timed out client-side after 30 s ("signal timed out"), and never reached the server process — a starvation that presents exactly like a server hang and misdirected an earlier watchdog fix ([2026-10-27-workspace-fs-stall-watchdog](2026-10-27-workspace-fs-stall-watchdog.md)). The failure is a *class*, not one bug: the same arithmetic kills the page with two terminals (each also holding a hold stream) plus a browser view plus two directories, and any future per-entity stream family inherits it. The incident's diagnosis (client pool starvation, not host stall) came from three-way evidence: a live client event loop, zero new server access-log entries, and zero stream-admission logs.

## Decision

All four families multiplex onto **one page-scoped, downlink-only WebSocket** — `/api/events.streams`, the third downlink class beside mux (session events) and host (host events). The page's long-lived connection count becomes a constant three, independent of directory, terminal, workspace, browser, and session counts.

- **Carrier.** `events.streams({page})` is a stream producer like mux/host: one bounded `FrameQueue` per socket, registered in a page→faces table (the `pageStreams` pattern). The `page` query token is **required** and validated before upgrade, mirroring the mux token rules. The socket is strictly downlink (a client message closes 1008), and `dshRemoteHost` bridging covers remote machine targets exactly like mux/host.
- **Substreams.** `events.streams.open({page, family, payload})` is an ordinary unary POST (capability `harniverse.observe`, effect `read` — the same presence-shaped classification `events.adopt` set) that mints a `sub` id and runs the family's **identical producer** (the hoisted `terminalStream`/`holdStream`/`browserStream`/`watchFilesStream` — one behavior, two carriers). Frames flow as `sub/ready` → `sub/frame` (family frame verbatim) → `sub/end`. `events.streams.close({page, sub})` is idempotent. The page's last live downlink aborts every substream it still holds — the substream form of stream-abort detach, preserving terminal/browser exclusive-attachment and hold retention semantics exactly.
- **Per-family semantics unchanged.** Terminal strict-sequence failure, browser newest-image-wins collapse, and watch burst coalescing all stay inside their producers; family failures keep riding the family's own `stream/error` frame inside `sub/frame`. A substream's failure never fails the channel, and the channel's failure ends each substream as a transport error so each consumer's **own recovery ladder** (terminal reattach, watch backoff, browser reattach) reopens it — the channel itself never auto-reconnects.
- **Bounds.** `events.streams.open` refuses `stream-channel-absent` when the page holds no live downlink, and per-page substreams are capped by `entityStreamSubsMaxPerPage` (default `256`, `stream-sub-limit-reached`) — the registry bound the watch cap already applies per workspace, now at page scope for every family.
- **Legacy paths.** Browser GETs (`Sec-Fetch-Site` present) to the four family paths answer **410** (mux/host keep their 426 for every network GET); first-party non-browser clients — the desktop main process, scripts — keep the per-family SSE routes over loopback, as does `toFetchHandler`'s in-process carrier as the isomorphism proof.
- **Client.** `WebApiClient` carries the page token and lazily opens one `EntityStreamChannel` per machine generation; the four `IApiClient` opener signatures are untouched, so every consumer (terminal/browser panels, workbench change-feed, editor watch) migrated with zero code change. Subscriptions open through the ordinary unary carrier (so generation fencing, authentication, and the diagnostics tap all apply); frames validate against the family's own schema at yield time; unclaimed frames (arriving between POST and its resolution) buffer bounded; caller abort fires the idempotent close.
- **The guardrail.** A connection-budget ledger counts every WebSocket and long-lived SSE stream the page opens and warns once past six — so a future per-entity fan-out is loud in dev. The `stream-connection-budget` e2e drives directory watches plus a live terminal and asserts, at the CDP level: exactly three event WebSockets, zero requests to the legacy family paths, and a file read still completing. The incident class is now a pinned invariant, not a hope.

## Consequences

- A page holds at most three long-lived connections (mux, host, streams) plus ordinary short-lived fetches, under both HTTP/1.1 (six per origin) and any HTTP/2 front (three streams); multiple tabs multiply by exactly three each instead of by watched entities.
- Terminal and browser attachment claims now live one hop further (open POST → producer), so a lost close POST reaps the attachment only when the page's last downlink dies; a healthy page reaps immediately on abort (close control) or consumer return. Both paths are tested.
- The channel adds one serialization hop for entity frames; terminal output ordering is per-substream FIFO (single socket, single delivery ring per substream), and the browser image stream can no longer starve unrelated fetches by occupying pool slots.
- The in-process carrier keeps the family SSE routes: host-side tests, `InProcessApiClient`, and the fixture ride them unchanged, and the fixture's `streamsOpen` answers the honest `stream-channel-absent` refusal (no downlink exists there).
- The 2026-10-04 note's "no WebSocket for the watch stream" rejection is superseded for the *network* carrier: a third transport for one family doubled the carrier surface; one shared channel for all four families halves it. The 2026-08-04 note's "one downlink WebSocket per stream class" pattern is *extended*, not reversed — entity streams are the third class; its downlink-only rule and pre-upgrade validation rules apply verbatim.

## Verification

- `packages/host/apiproxy/tests/api-proxy-entity-streams.spec.ts`: sub/ready→frames→sub/end for a terminal substream; hold delivery and page-death reaping; `stream-channel-absent`, idempotent close, and the per-page cap; a watch refusal riding `sub/frame`.
- `packages/client/connection/tests/streams-channel.client.spec.ts`: one socket for two families, per-sub routing, identity publication, unclaimed buffering with bound, socket-death failure vs silent aborted ends, caller-abort close (and its suppression on generation retire), malformed-frame drop, socket-failure retry cleanliness, budget counting.
- `packages/client/connection/tests/websocket-downlink.host.spec.ts`: page-token validation before upgrade, principal attachment, verbatim substream framing, downlink-only enforcement on the third socket.
- `packages/client/connection/tests/node-half.host.spec.ts`: three upgrade routes, 426 on all event-path GETs, browser-gated 410 on the four legacy family GETs (first-party GETs pass through).
- `apps/web/tests/stream-connection-budget.e2e.ts`: CDP-level budget assertion under real composition (three WebSockets, zero legacy GETs, read completes).
- `test:gui` 529 files / 7,586 tests green; `DSH_SNAPSHOT=replay pnpm run test:web` green (goldens unchanged — a wire-only change).

## Alternatives considered

- **Per-workspace multiplexed watch stream** (the internal diagnostic fix): collapses the directory fan-out but leaves terminal/hold/browser per-entity and the workspace count linear — N workspaces still exhausts the pool; the class survives.
- **Fold entity streams into the mux WebSocket:** rejected — the shared bounded mux queue couples terminal strict-sequence and 30 fps browser images to session events (overflow fails the whole page stream, a pinned behavior), and mux presence/replay semantics would entangle with attachment lifecycles.
- **Full-duplex WebSocket with uplink messages:** rejected — downlink-only is a load-bearing security property (every mutation passes the POST envelope fences); subscription control as ordinary unary POSTs keeps every fence, the idempotency ledger, and remote-host bridging for free.
- **HTTP/2 deployment:** out of the product's control (the webserver is HTTP/1.1; proxies vary); the budget must hold in the worst environment.
