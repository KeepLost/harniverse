# Agent Note: Browser targets for SSH-managed remote hosts

Status: implemented

English | [中文](2026-09-27-remote-host-browser-target.zh.md)

## Problem

The local remote-host coordinator can deploy, authenticate, synchronize, and keep a remote Harniverse process alive, but the browser connection layer originally had only one implicit local Host target. A connected SSH record therefore had no way to open remote workspaces or deliver remote Session events without exposing the remote Access Token or moving local management authority.

## Decision

The remote-host view switches the current page's machine through `connection.switchTarget({ kind: 'remote', id })` in the same document (see the [same-page machine-targets Agent Note](2026-09-30-same-page-machine-targets-and-settings-materialization.md) for that mechanism); `dshRemoteHost=<RemoteHostId>` remains the carrier routing parameter. The existing Connection carriers add that target to ordinary `/api` requests, uploads, and `events.mux`/`events.host` WebSockets. `remoteHosts`, `settings`, and `credentials` remain local so the original page stays the management and synchronization authority.

The Host Connection layer authenticates the browser locally, resolves the target endpoint against the generated Typert policy or legacy API capability map, and rejects unknown or unauthorized targets before forwarding. The SSH coordinator removes local browser credentials, authenticates the upstream request with its per-host Grant, forwards the request through the existing remote loopback transport, and rewrites JSON carrier identities to the local browser generation identity. Remote event sockets are bridged with the same local admission and carry no remote token to the browser. Closing a page does not dispose the SSH coordinator or remote process; disconnecting the coordinator closes the browser generation and lets the normal durable-cursor reconnect path recover after a later connect.

Model and search settings remain local-authoritative: the coordinator synchronizes complete resolved sections on connect, while the remote page executes the resulting API and Agent operations remotely. Explicit reverse mappings rewrite matching model/search origins to allocated remote loopback ports during synchronization; they are never inferred from a browser target.

## Alternatives considered

- Exposing the SSH local-forward port directly to the browser: rejected because the browser would need remote Access Token handling and a second trust boundary outside the authenticated Host.
- Replacing the local page's global Connection instance in place: rejected because local management would silently follow a remote workspace and unrelated local and remote session identities could collide.
- Sending `remoteHosts` management calls to the target: rejected because host lifecycle, credentials, settings authority, and reconnect ownership belong to the original local coordinator.
- Creating a second browser runtime package: rejected because the existing Connection, Typert, Session, Workspace, and WebSocket carriers already provide the required lifecycle and durable cursor behavior.

## Consequences

The management view reaches the coordinator through the `remoteHosts` contribution mounted in the `api-remotes` Client assembly; without that mount the `ui-remote-hosts` plugin waits on `remote.remoteHosts` and registers no sidebar entry. Host removal is exported as `remoteHosts/removeHost` because the Gateway namespace Service owns `remove` as its unmount path; the local Service method remains `remove`. The browser path resolver and the Host proxy resolver both end the namespace at the first `/` or `.`, so Typert `settings/...` endpoints and legacy `settings.describe`/`credentials.set` methods stay local alike.

Remote machines are per-host browser targets that isolate runtime persistence through machine-keyed store and selection namespaces in the same document (the linked note above owns that mechanism). A remote target requires the local coordinator to remain connected; it does not reconnect SSH itself. The Host proxy must preserve local capability checks and identity metadata, and the remote coordinator must remain the only owner of upstream tokens and socket lifetimes. Native SSH deployment and full Linux/macOS/Windows verification remain separate from browser carrier tests.

Focused tests cover remote target URL routing, local management exclusion, targeted HTTP proxy authorization and identity handling, Remote-result failure rendering, ephemeral credential submission, connected-host opening, reverse-origin synchronization, the existing carrier suites, and the remote artifact lifecycle smoke. Full browser reconnect and real SSH host verification require the configured Linux test host.
