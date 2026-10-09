# Agent Note: Workspace file watching and open-in-default-app hardening

Status: implemented

English | [中文](2026-10-04-workspace-file-watching-and-open-in-default-app.zh.md)

Scope: `packages/host/apiproxy` (`src/workspace-watcher.ts`, `src/api/workspace-files.ts`, `src/api/workspace-files.schema.ts`, `src/api/rpc.ts` + `rpc.schema.ts` + `rpc-map.ts`, `src/api-proxy.ts`, `src/fetch/client.ts`, `src/fetch/handler.ts`, `src/index.ts`, `src/workspace-inspector.ts`), `packages/client/connection` (`src/client/web-api-client.ts`, `src/client/api.ts`, `src/client/index.ts`, `src/client/fixture.ts`), `packages/api/remotes` (`src/client/index.ts`), `packages/client/runtime` (`src/client/workspaces/change-feed.ts`, `src/client/workspaces/service.ts`, `src/client/contract/workspaces.ts`, `src/client/index.ts`), `packages/client/ui-workspace` (feed lifecycle in `WorkspaceWorkbench.tsx`, `fileWatch` store field, tree-row and preview-header open actions)

## Problem

Blueprint row R29 (item X13): Harniverse's workspace file tree refreshed only manually, and `host.openPath` accepted any string the client sent. Upstream added a watched file API (`workspace-files` changes stream with parent-directory re-anchoring) plus a trust-fenced open route; its "open with" application catalog was already rejected by the recorded disposition, leaving Harniverse to adopt the open actions and the watch feed on its own carrier.

## Decision

- **Watch engine (host).** One `workspace-watcher.ts` subscription owns exactly one live `fs.watch`: recursive where the platform supports it, re-anchored downward otherwise. A currently missing target is legal — the watcher binds its nearest existing ancestor so the target's creation still fires, and a deleted directory target re-anchors the same way (inode replacement closes the lost-write race with a post-rebind re-stat). Raw bursts collapse into one trailing frame per `fileWatchDebounceMs` window (default 50 ms). A 500 ms probe (`lstat`) of the target backs the watcher: a disagreement with the last reported state that persists across two consecutive ticks schedules a burst, so an event the platform watcher never delivered still surfaces. macOS starts its FSEvents stream asynchronously after `fs.watch` returns and loses events in that gap; the macOS CI lane lost the creation of a missing target and the removal of a watched directory this way, and widening the test budgets never helped because the event was never delivered. The two-tick rule keeps a healthy watcher from producing duplicate frames, and the probe runs on every subscription type because it needs no knowledge of which backend lost the event; per-workspace concurrency is capped by `fileWatchMaxPerWorkspace` (default 64) with a typed refusal. Escape from the workspace root or a crossing symlink refuses with `workspace-path-invalid` rather than watching outside the tree.
- **Carrier.** The frames ride the existing no-envelope SSE carrier as `GET /api/workspace.files.watch?workspaceId=&path=` behind the browser carrier's standing authentication fence (the same fence every `/api` route already carries — upstream's separate `connection` service is not duplicated); the capability gate is `harniverse.observe`, identical to the unary reads. Failures close with the house-standard `stream/error` envelope, so the client's generic SSE reader stays the only new carrier code: `AbstractApiClient.openWorkspaceFilesWatch` + one `IApiClient.workspaceFiles.watchFiles` member, fenced per generation in `web-api-client` exactly like the terminal stream.
- **Client feed.** `ChangeFeed` (client/runtime) owns one subscription per expanded tree directory: `ready` resets the failure account, `change` schedules a trailing-coalesced relist of the delivering directory, stream failures reopen with the connection loop's backoff shape (jittered cap), and five consecutive failures drop the whole workspace to manual mode (watches torn down, `onMode` once) while the manual refresh button keeps working. Typed refusals end only their own directory quietly. The runtime service maps the host closers to `WorkspaceFileWatchError` (`workspace-watch-unsupported` and `workspace-watch-limit-reached` both refuse the watch itself; `workspace-not-found`; `workspace-path-invalid` → `outside-workspace`); any other error keeps its transport form so the reconnect path owns it.
- **Open actions.** `host.openPath` now fences the wire face: only an absolute path naming an entry the host can stat opens (`bad-request` / `host-path-not-found`, one shared refusal so a caller cannot probe which); host-resolved internal opens keep the unchanged seam. The tree row and the preview header expose "open in default application" gated on the already-client-visible `hostDescription.canOpenPath` fact (no UA sniffing); the application catalog, per-app icons, and launcher resolution stay rejected.

## Alternatives considered

**Upstream's separate `connection` trust-fence service.** Rejected: the browser carrier already authenticates every `/api` route; duplicating the fence per route family would move security assertions away from the one admission point that owns them.

**A WebSocket upgrade for the watch stream.** Rejected: the existing SSE carrier (`readSse`) already streams terminal/host/mux frames through the fetch handler with authentication, backpressure, and frame-schema parsing; a second transport would double the carrier surface for one more stream family.

**Watching through the unary client with polling.** Rejected: polling hides deletion latency behind a cadence constant and burns capability checks; the frame stream pushes coalesced truth, and the manual-mode fallback bounds the failure story.

**The official open-in-app catalog with per-application launchers.** Rejected by the recorded disposition: `host.openPath`'s OS-default hand-off plus the stat fence covers the product surface without launcher templates, icon extraction, or their probe timeouts.

## Consequences

Expanded tree directories refresh themselves; a watcher-hostile deployment degrades a whole Workspace to manual refresh after five consecutive stream failures rather than silently stalling. Watch subscriptions consume one of `fileWatchMaxPerWorkspace` (default 64) concurrent watches per Workspace, so pathological tree expansions surface a typed refusal instead of unbounded watcher growth. The wire-facing `host.openPath` now refuses relative and missing paths before any native hand-off, which also removes the ability to probe existence through the open route (one shared refusal). The application catalog, per-app icons, and launcher resolution stay rejected: every open goes to the OS default application only.

## Verification

Host: `packages/host/apiproxy/tests/workspace-file-watch.spec.ts` (15 specs: frames, coalescing, ancestor re-anchor, caps, disposal, SSE framing, 400 query), `api-proxy-workspace.spec.ts` openPath fence cases. Client: `workspaces-change-feed.client.spec.ts` (11), `workspaces-watch.client.spec.ts` (3 mapping cases), `workspace-workbench.client.spec.ts` watch/action tests. Full-tree `tsc -b` aggregates clean; scoped type-aware lint clean.
