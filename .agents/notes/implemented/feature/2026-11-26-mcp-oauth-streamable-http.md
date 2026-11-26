# Agent Note: MCP OAuth — passive connections, explicit authorization through the management Remote

Status: implemented

English | [中文](2026-11-26-mcp-oauth-streamable-http.zh.md)

## Problem

A remote MCP server of kind `streamable-http` may refuse every request with 401 and point at OAuth 2.0 Protected Resource Metadata: the client has to discover the authorization server, obtain client information (dynamic registration or a configured id), run a PKCE authorization-code flow in a browser, and keep the access token refreshed. The bridge could only attach static `headers`, so such a server was unusable: each attempt failed, the supervisor spent its reconnect budget, and the model got a server with no tools and no reason. Three constraints shape any solution. Fleet connections start at boot and on every settings change, so that path must never open a browser or register a client. A browser can only return to a listener the Host controls. And the protocol code has to live where the MCP SDK is already declared — [`dsh-mcp-client`](../../../../packages/mcp/mcp-client/README.md) — while the settings namespace and the management Remote live in [`dsh-mcp-user-config`](../../../../packages/mcp/mcp-user-config/README.md), which declares neither the SDK nor the credentials seam, and no dependency may be added.

## Decision

Connections stay passive; authorization is an explicit operation of the `mcpManagement` Remote.

- **Config** (`packages/mcp/mcp-client/src/config.ts`): a Streamable HTTP entry gains `oauth: true | { clientId?, scope?, requestTimeoutMs = 10000, authorizationTimeoutMs = 600000 }`. `oauth` together with an `Authorization` header on the same entry is a validation error, raised by `resolveOAuthConfig` at the earliest resolvable point — the plugin load of `dsh-mcp-client`, the owner load of the shared fleet, and the settings write in `dsh-mcp-user-config` — as are an unknown option, a non-HTTPS non-loopback endpoint, and `oauth` on a stdio entry.
- **Grant record** (`packages/mcp/mcp-client/src/oauth-store.ts`): one self-contained, versioned JSON document per server under the credentials-seam reference `mcp_oauth_<hex of the server key>`, where the key is a shared owner's settings id or a standalone row's `serverName`. It binds the endpoint URL, the authorization server, the client information, the resource indicator, the configured client id and scope, and the tokens to each other. A grant is used only when every binding matches the current configuration.
- **Passive session** (`packages/mcp/mcp-client/src/oauth-session.ts`): the transport's endpoint requests go through a fetch that attaches the bearer; a token past its deadline is refreshed single-flight and serialized per grant reference for the whole process, and a sign-out or a committed grant queues behind a refresh of the same record. When no usable grant exists the connection rests in the new state `waiting-authorization` with reason `missing`, `expired`, `binding`, `rejected`, or `scope`, keeps its last good inventory, and does not spend its reconnect budget. Tool and resource calls fail with `McpLocalError` code `MCP_AUTHORIZATION_REQUIRED` and message `MCP OAuth requires authorization: <reason>`. A refused request is retried once after a forced refresh; a repeated 401 is `rejected`, a 403 `insufficient_scope` is `scope`. A transient failure stays with the ordinary reconnect loop. The probe attaches a stored grant and otherwise reports the missing grant as a connect failure.
- **Protocol flow** (`packages/mcp/mcp-client/src/oauth-flow.ts`): the SDK's discrete functions (`discoverOAuthServerInfo`, `registerClient`, `startAuthorization`, `exchangeAuthorization`, `refreshAuthorization`, `extractWWWAuthenticateParams`) are composed step by step. Every OAuth request runs through a fetch that enforces HTTPS-or-loopback, a per-request deadline, and no redirect following, and carries neither resource headers nor a stored token. A dynamically registered client is reused while the redirect URI is unchanged; an authorization server that no longer knows it invalidates the record.
- **Explicit authorization** (`packages/mcp/mcp-user-config/src/authorization.ts`): `startAuthorization`, `cancelAuthorization`, and `signOut` are Remote methods behind `harniverse.administer`. One attempt per server moves through `starting`, `waiting-browser`, `exchanging`, `committing`, then `authorized`, `cancelled`, or `failed`, bounded by `requestTimeoutMs` per authorization-server request and by `authorizationTimeoutMs` across the browser wait and token exchange; a second start joins the pending attempt. Status rows gain `authorization` (state and reason) and `attempt` (id, phase, deadline), and every phase change reuses the forwarded `mcpManagement/fleet-changed` event.
- **Callback route**: registered for the attempt's lifetime as an exact public route `/mcp/oauth/callback/<sha256 hex of the server id>` on `ctx.webServer`. It admits only the redirect URI's own authority, requires GET, judges the parameters for shape, compares the single-use `state` in constant time against the pending attempt, and answers with one of two static bilingual pages that echo no request value. Failures are logged as a safe local message, never as a code, state, or token.
- **Redirect origin**: the default is the loopback form of the web listener's own origin. A browser-supplied origin is accepted only when it is loopback, or HTTPS and accepted by the connection's `isTrustedWebOrigin` — the `/api` Host fence of the [inbound authentication rules](../../../../docs/subsystems/authentication.md) over the deployment's `trustedHosts`. This method is the one additive edit outside the owning packages.
- **UI** ([`dsh-client-ui-settings-mcp`](../../../../packages/client/ui-settings-mcp/README.md)): the server card shows the grant state and offers Authorize, Cancel, Sign out, and — once the Host answers — a plain link to the authorization page; the editor's OAuth section carries the client id, scope, and the two timeouts. All copy is locale-owned in Chinese and English.

The architecture stays plugin-native: each registration is a Cordis effect, the callback route is released by its effect disposer, and the three packages reach each other only through the connection handle, the typed wire rows, and structurally read optional services (`credentials`, `webServer`, `connection`), so no package dependency and no lockfile change is needed.

## Why the SDK's own `authProvider` orchestration is not used

`StreamableHTTPClientTransport` calls the SDK's `auth()` orchestrator on 401 and 403. That orchestrator performs dynamic registration and the browser redirect on its own schedule, forwards the transport's `requestInit.headers` to authorization-server endpoints, and would make a passive connection register a client or redirect. The session therefore attaches the bearer in its own fetch and calls the discrete protocol functions only from the explicit flow. Upstream DeepSeek Harness reached the same split on SDK v2, whose transport exposes a token hook instead; its code was compared for design only.

## Known limitations

- **LAN access**: the default redirect origin is loopback. A browser on another machine must supply its own origin, which the connection accepts only when that host is in `trustedHosts`; the shipped CLI derives the machine's LAN IP literals into that list.
- **HTTPS by name**: a deployment reached as `https://<name>` needs that name in `trustedHosts`; otherwise the loopback default produces a redirect URI whose certificate does not match, and the browser cannot complete the callback.
- **Authorization servers that refuse loopback or IP-literal redirect URIs** cannot be used from a loopback deployment; a named HTTPS deployment is required.
- **Standalone rows** (`cordis.yml`) have no in-process authorization path; they use a grant already stored under their `serverName`.
- **External edits** of a grant record are not observed while the connection waits; it re-judges the grant on its next mount or `resume()`.
- `McpOAuthCredentialStore` lives in `src/types.ts`: the `/types` subpath is mapped to source for every Client type program, so it must stay free of runtime imports, or type-aware Client checks lose the `Context` merges.
- **A replaced connection cancels its attempt**: remounting the owner while the browser is open settles the attempt as `cancelled`.

## Alternatives considered

- **The transport's `authProvider` with the SDK's `auth()` orchestrator** — rejected: it registers and redirects implicitly, which the passive path must never do, and it forwards resource headers to authorization-server endpoints.
- **A separate OAuth service or a new subpath export from `dsh-mcp-client`** — rejected: `verify-plugin-entry-exports` admits only Loader fields and `Service`/`Error` classes on a plugin entry, a new subpath would need a root `tsconfig.base.json` path mapping, and neither has a second consumer. The connection handle already crosses the package boundary.
- **Separate records for the client registration and the tokens** — rejected: one record is one unit for sign-out and binding; a registration that the server forgets invalidates the grant with it.
- **Passing the callback through the `/api` bridge or `authorizeHttpRequest`** — rejected: the authorization server's redirect is a cross-site navigation that the trust fence refuses, and the browser session cookie is `SameSite=Strict`; the one-time state is what authenticates the answer.
- **A scripted `window.open` from the card** — rejected: the Remote call outruns the browser's user-activation window, so the popup would be blocked; the card reveals a link instead.
- **Accepting any browser-supplied origin, or none** — rejected: any origin lets a caller send the authorization code to a host of its choice; none makes LAN and named deployments unusable.
- **Following same-origin redirects on OAuth requests** — rejected: a redirected token or registration request carries its body to a destination the metadata never named.

## Consequences

- A missing or refused grant is a first-class, explainable rest state instead of a silent retry loop; the model and the settings page both see the reason.
- Tokens never reach a log, a status row, an event, or the UI: status carries only the state, the reason, and an expiry, and the authorization page URL is returned only to the caller of `startAuthorization`.
- The generated Typert artifacts and the API, client, config, and Cordis catalogs are stale until they are regenerated; the Remote methods exist in source, and the settings page's wiring of them type-checks only against the regenerated Remote.
- A grant is bound to its endpoint and options, so changing `url`, `clientId`, or `scope` requires a new authorization, and an attempt that outlives its connection is cancelled rather than transferred.

## Verification

- The `oauth-config`, `oauth-flow`, and `oauth-session` specs under `packages/mcp/mcp-client/tests/` drive the real SDK client and auth functions against a loopback fixture that serves a bearer-guarded MCP endpoint, protected-resource and authorization-server metadata, registration, authorization, and token endpoints: the passive rest state and its reasons, single-flight refresh, recovery on 401 and 403, sign-out, resume, binding, the probe, PKCE registration, issuer binding, servers without metadata, and the transport rule.
- `packages/mcp/mcp-user-config/tests/authorization.spec.ts` and `oauth-settings.spec.ts` cover the Remote operations, the callback route (shape, state replay, authority, method, deadline, cancellation, safe logging), redirect-origin validation, settings refusal before any owner mounts, and a real composition that authorizes a fleet server end to end.
- `packages/client/connection/tests/rpc-host.host.spec.ts` covers `isTrustedWebOrigin`; `packages/client/ui-settings-mcp/tests` cover the controller, the card, the editor, and the apply wiring.
- Every touched source file meets the per-file 100% coverage gate under focused runs.
