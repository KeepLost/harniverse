# Agent Note: the browser panel becomes a host browser process

Status: implemented

English | [中文](2026-09-22-host-browser-panel-egress.zh.md)

## Problem

W14 shipped the browser panel as a sandboxed `<iframe>` in the user's own browser, mirroring upstream's `ui-sidebar-browser`. That carrier answers a different question than the one the surface exists for.

- Egress came from the user's device. Every request carried the user's IP, DNS, and proxy, so `localhost` in the URL bar meant the user's localhost. The one destination a harness user most often wants — a dev server an Agent just started on the harness host, or an internal dashboard only the host can route to — was structurally unreachable.
- The panel disagreed with the harness's own posture. The model's `web_fetch` leaves from the host through `web-fetch-http`; the human's browser panel left from the laptop. Two different network identities for one product.
- Embedding was refusable. `X-Frame-Options` and CSP `frame-ancestors` blank the frame, and the refusal is undetectable from JavaScript, so the panel could not even say why a page was empty. Upstream documents the same blindness, including that Web mode cannot read the frame's current URL after an in-frame navigation.
- Nothing pointed at the panel. Harniverse had no `openExternalLink` equivalent, so conversation links still opened browser tabs and the panel's only entry was a footer button with an empty URL bar.

## Decision

The panel becomes a remote view of a real browser process running beside the harness, and the host owns the page.

A new `packages/api/browser-controller` mirrors `terminal-controller`'s lifecycle model: a `TypertRemoteService` under the `browser` namespace, per-Session ownership, caller-minted identities, idempotent create, a `maxPages` bound, capability-gated verbs (`environment`/`list` observe; `create`/`navigate`/`act`/`input`/`resize`/`close` operate), and a non-`@Remote` `follow()` generator the apiproxy wraps as the `events.browser` SSE stream. One Session launches at most one Chromium, memoized: the first page starts it, the last page released shuts it down.

Control speaks CDP over Node's global `WebSocket`, so the capability adds no dependency. Pixels come from `Page.startScreencast` as JPEG frames and input goes back as `Input.dispatch*` with page-space coordinates, so the host never sees the client's element geometry. History is `Page.getNavigationHistory` plus `navigateToHistoryEntry`, because the protocol exposes entries rather than back/forward.

Three deliberate differences from the terminal:

- Frames collapse instead of failing. A terminal's bytes are an ordered stream, so a slow follower must fail and recover from a snapshot. A screencast frame is a complete image, so each follower keeps the newest image and the newest metadata and a slow consumer merely loses intermediate frames.
- The browser runs `ambientEnv: 'scrubbed'`, not the `'full'` inheritance the user's terminals get. A terminal *is* the user's shell; a web page is not, and must never see harness credentials. Each Session also gets a throwaway profile directory, removed when the browser goes away.
- Navigation policy is host-side and operator-owned. The previous client-side `reviewNavigation` was a UI guardrail a client could simply not run. The host now reviews before the browser moves: http/https only, no embedded credentials, and loopback/link-local/private ranges refused unless the operator sets `allowPrivateAddresses` — the one switch that makes "reach the dev server on the host's localhost" possible, and which by the same reachability exposes the host's internal network, so it is off by default and `allowedHosts` narrows it further.

Link routing lands with it. `ILayout.setCenterView(id, request?)` carries an uninterpreted request string to the view; `ui-primitives` markdown gained an `externalLinks` opener that preventDefaults a plain left click while keeping the anchor's `target="_blank"` for modified clicks and assistive technology; `ui-conversation` routes to the panel when `center.view` has a `browser` entry and to `window.open` otherwise.

## Alternatives considered

- A host HTTP reverse proxy serving remote pages under the harness origin: rejected on two counts. `frontend-static` and `apiproxy` share one origin, so proxied page scripts would be same-origin with an authenticated API that can spawn shells and full-access subprocesses — remote code execution by construction. And URL rewriting of HTML, CSS, JS, and every dynamic request is an endless treadmill that multiplies the SSRF surface rather than bounding it.
- Keeping the iframe and adding a host fetch fallback for refused pages: rejected — two carriers with different capabilities, cookie jars, and failure modes behind one URL bar, and the fallback cannot run scripts, which is most of what a page is.
- Playwright or Puppeteer as the driver: rejected for a shipped capability. Both bring a browser-download story and a much larger surface than the ten CDP commands this needs; the protocol is stable and the platform already has a WebSocket.
- DNS pinning per navigation, as `web-fetch-http` does for the model: not possible from outside the browser. Chromium resolves names and fetches subresources itself, so the honest contract is that the host review binds the destination the user typed and the operator allowlist is the load-bearing control. Recorded as a limitation rather than implied by a check that cannot exist.
- Deferring the redefinition to W16 (Electron), where a real browser view exists natively: rejected — W16 depends on W13 and W14 being right, and the egress question is not a desktop-packaging question.

## Consequences

Page traffic leaves the host. The e2e proves it directly: a throwaway `node:http` origin on 127.0.0.1 serves a page with `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`, the panel renders it, the server records the request, and Playwright's record of the user page's own requests to that origin is empty. Clicks and typing reach the real page, which echoes them back to the test server; `file:///etc/passwd` is refused host-side with a panel notice.

The costs are real and deliberate. A Session that opens the panel costs a Chromium process (CPU, memory, and JPEG frame bandwidth); Chromium's own sandbox must be waived when the harness runs as root, which is the common container posture, leaving the scrubbed environment and the isolated profile as the boundaries; and the surface is one page per tab with no popups, downloads, printing, permission prompts, or clipboard bridge.

The old client-side `browser.allowedHosts` settings namespace is gone, because policy that a client enforces is not policy. A deployment that wants a locked-down panel now configures the `browser-controller` row.

## Scope

New `packages/api/browser-controller` (`types`, `cdp`, `policy`, `stream`, `launch`, `page`, `index`, `invariant`) with its suite; the apiproxy `events.browser` binding, frame union, schema, stream implementation, GET route, client face, and four RPC error codes; `ui-browser` rewritten around a `BrowserPanelController` and an imperative image surface, with its node half reduced to an empty `apply()`; `ui-layout`'s center-view request; `ui-primitives` markdown external-link routing and `ui-conversation`'s opener; the `web-app` composition row; the new subsystem page pair, both README pairs, and the regenerated catalogs and graphs; `apps/web/tests/browser-panel.e2e.ts` with its overlay, and the inline-code-link e2e updated for the new routing.
