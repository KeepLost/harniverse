# @deepseek-ai/dsh-api-browser-controller

English | [中文](README.zh.md)

Host-side browser Remote. `ctx.browserController` runs a real Chromium process beside the harness, owns its pages per Session, and serves them to the browser panel as screencast images plus page metadata. Page traffic therefore leaves the **host's** network position, not the user's device: a workspace dev server on the host's own localhost is reachable, the target sees the host's address, and pages that refuse embedding (`X-Frame-Options`, CSP `frame-ancestors`) render normally because nothing is being embedded. The [subsystems page](../../../docs/subsystems/browser-controller.md) owns the wire shapes, the control and policy semantics, and the CDP command vocabulary.

The surface is a carrier for a human, not a model seam: the controller is a Host Remote gated by the authenticated API, page content emits no session-log events, and the model's own fetching stays in [`web-fetch-http`](../../web/web-fetch-http/README.md) with its separate pinned-lookup policy. Browser processes run with `ambientEnv: 'scrubbed'` — unlike the user's terminals, a page never inherits harness credentials — under a throwaway profile directory per Session. The directory is removed after the browser tree and process completion settle, whether startup fails, the last page closes, or the Session disposes; failed teardown retains process and directory ownership for retry.

## Service: `BrowserController` (ctx key: `browserController`)

On macOS the disposable profile uses `--use-mock-keychain` to avoid OS Keychain access prompts during navigation. Cookies in this temporary profile are not protected by the user's Keychain; its directory lifetime and Chromium sandbox policy remain unchanged.

The service extends `TypertRemoteService` under the `browser` namespace. `environment` and `list` need `harniverse.observe`; `create`, `navigate`, `act`, `input`, `resize` and `close` need `harniverse.operate`. Create is idempotent for an open identity within one Session's registry, closed identities cannot be recreated, and the per-Session page count is bounded by `maxPages`. One Session launches at most one browser: the launch is memoized, the first page starts it and the last page released shuts it down, so a panel left closed costs nothing.

Navigation is reviewed on the host before the browser is asked to move: only `http`/`https`, no embedded credentials, and loopback, link-local and private ranges are refused unless `allowPrivateAddresses` is set. A non-empty `allowedHosts` narrows the surface further, matching a host exactly or as a subdomain. Refusals surface as the `browser-navigation-refused` Remote error, never as a silent blank page.

The executable is resolved in the Session's own execution environment: `executablePath` when set, otherwise `browserCandidates` probed in order (Chrome, Chromium, and Edge under their Linux names and their macOS and Windows install paths). A deployment whose host has no such program is a supported state, not a defect: `environment` answers `available: false` with a reason naming exactly what was probed, and `create` fails `browser-unavailable` with the same text, so the panel can tell the operator which name to satisfy or which path to configure. The client half offers the reader their own browser for conversation links instead.

The launch budget bounds each startup stage: the wait from spawn to the DevTools endpoint line, then the initial socket handshake and target-discovery reply, each within the full `launchTimeoutMs`. If either fails, `create` reports `browser-unavailable` with the DevTools failure and waits for the owned process tree to stop before removing its profile. If termination cannot be confirmed, the failure reports both the original cause and the cleanup failure; the Session retains the handle and profile for a later close or disposal, and a new launch cannot replace that tree until cleanup succeeds.

One attachment at a time holds control; a later attachment takes it and the earlier one is demoted to watching, so navigation and input from a stale attachment fail `browser-control-unavailable` rather than fighting for the page. Frames are complete images, so each follower keeps the newest image and the newest metadata instead of an ordered backlog — a slow consumer loses intermediate frames and never fails its stream.

The `follow` generator is a plain host method rather than an `@Remote` declaration: harniverse's Gateway dispatch is unary, so the host `apiproxy` wraps it as the `events.browser` SSE stream on the EventsApi surface.

## Model Experience

None, as the package serves the browser panel and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; page content never enters a model request or the Session log.

## Known Limitations and Deferred Work

- Chromium resolves DNS and fetches subresources itself, so the host review binds the destination the user typed, not every address the page subsequently reaches; a name that resolves to a private address after the review passes is not re-checked. The model's fetch seam pins lookups per request precisely because it can.
- The panel is a single-page-per-tab surface: popups the page opens are not adopted, and a target the page opens itself stays invisible to the client.
- No downloads, printing, file-chooser, or permission-prompt handling; a page that needs one of those stalls without a panel-visible reason.
- Chromium's own sandbox cannot start when the harness runs as root, which is the common container posture, so the default `sandbox: 'auto'` drops it exactly there and keeps it everywhere else; the process still runs scrubbed and profile-isolated, but a page exploit then faces one fewer boundary. `sandbox: 'chromium'` demands the sandbox and leaves a root deployment with no browser at all; `sandbox: 'none'` always drops it.
- Screencast images are JPEG, so text is softer than a native page and quality trades against bandwidth through `screencastQuality`; there is no lossless or vector path.
