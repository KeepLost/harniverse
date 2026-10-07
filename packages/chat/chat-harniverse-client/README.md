# `@deepseek-ai/dsh-chat-harniverse-client`

English | [中文](README.zh.md)

The chat bridge's only client of the Harniverse `/api`. The default export `HarniverseClient` provides `ctx.harniverseClient`. It authenticates with a public-key Grant, refuses every endpoint outside a closed table, forwards `Idempotency-Key`, binds mutations to the carrier's principal identity, and keeps a resumable event stream. `/api` itself is unchanged: this package is an ordinary operator client.

## Config

The service injects `credentials`. Secrets never appear in configuration; the Grant id and signing key are credential references written by `dsh chat init`.

| Key | Type | Default | Notes |
|---|---|---|---|
| `origin` | string | `http://127.0.0.1:3080` | Loopback HTTP, or HTTPS; `GrantAccess` rejects every other origin. |
| `grantId` | string | — | Grant id; when omitted, read from the credential named by `grantIdRef`. |
| `grantIdRef` | string | `DSH_CHAT_BRIDGE_GRANT_ID` | Credential holding the Grant id. |
| `signingKeyRef` | string | `DSH_CHAT_BRIDGE_SIGNING` | Credential holding the PKCS#8 DER (base64url) P-256 signing key. |
| `requestTimeoutMs` | number | `30000` | Per-request timeout. |
| `muxRenewAfterMs` | number | `540000` | Age at which the mux socket is replaced; at most 840000, below the 15-minute Access Token cap. |
| `reconnectMinMs`, `reconnectMaxMs` | number | `1000`, `30000` | Exponential reconnect backoff bounds; the minimum must not exceed the maximum. |

## Endpoint table

Only these endpoints can reach `/api`. Any other method or Typert endpoint throws `endpoint-denied` before any network use and is logged; the `chat-harniverse/request` event announces each permitted request so the package invariant can assert table membership.

| Kind | Entries |
|---|---|
| Unary reads | `api.describe`, `host.describe`, `session.list`, `session.history`, `session.workStatus`, `session.models` |
| Unary mutations | `session.create`, `session.selectModel`, `session.selectModelTarget`, `session.rename`, `session.prompt`, `session.updateQueue`, `session.cancel` |
| Typert | `commands/execute` |
| Carrier | `POST /api/respond`, `POST /api/attachment/upload`, `GET /api/events.mux` (WebSocket) |

Each row validates the response value fields the bridge reads; a drifted wire shape fails as `protocol-violation`.

## Authentication and identity

`GrantAccess` signs a challenge with the key resolved from `signingKeyRef` and renews the short-lived Bearer token 30 seconds before expiry; the client never schedules token timers for HTTP. The first mutation learns the carrier's principal identity (`{ kind: 'grant', grantId, grantRevision }`) with a `host.describe` read, and later responses and the stream's first frame keep it current. Mutations send it as `expectedPrincipal`. On `authentication-principal-mismatch` the client adopts the identity the carrier reports and retries exactly once; `respond` follows the same rule. An instance that reports no authentication is refused with `authentication-failed`.

Mutating unary calls and Typert calls forward the caller's `idempotencyKey` as the `Idempotency-Key` header. The carrier scopes keys by principal and method and rejects a reused key with a different payload (`idempotency-key-reused`).

## Remote hosts

`remoteHost` adds `?dshRemoteHost=<uuid>` to any request kind, including the mux. It must be a lowercase version-4 UUID and is rejected locally otherwise. The local carrier forwards the request to the remote runtime and rewrites `expectedPrincipal` to the remote identity, so remote responses never change the client's local identity and a principal mismatch on a remote path is not retried.

## Event mux

`client.openMux(options)` returns a `HarniverseMux` bound to the calling effect scope. It connects to `events.mux` with the Bearer header and `since=<cursors>`, delivers `session/event`, `approval/requested`, `approval/resolved`, `question/requested`, and `question/resolved` frames in order with the server-request `rpcId`, and drops every other frame kind.

- Cursors advance from `session/event` sequence numbers; a replayed sequence number at or below the cursor is dropped, and `onCursor` lets the owner persist the position.
- A pending approval or question replayed after reconnect reuses its `rpcId` and is delivered once.
- A server close with code 4001 (Access Token expired or revoked) reconnects at once; any other close reconnects with exponential backoff.
- Before the Access Token can expire, after `muxRenewAfterMs`, the mux opens a replacement socket with the current cursors and closes the old one only after the new one is open.
- After each open it reads `host.describe`; a changed `bootId` calls `onHostRestart`.

## Errors

Every method throws `HarniverseError` with a closed `code`: `endpoint-denied`, `remote-host-invalid`, `credential-missing`, `authentication-failed`, `transport-failed` (with the HTTP `status` when the carrier answered), `rpc-rejected` (with the business `rpcCode`), or `protocol-violation`.

## Test seam

`internals.fetch` and `internals.createSocket` are the only external effects; tests replace them. The package tests run a fake carrier that verifies the P-256 signature of each challenge.

## Model Experience

None, as this client carries requests the chat bridge composes and registers no model context.

#### KV Cache effect

None; the client performs no model request.

## Known Limitations and Deferred Work

- Workspace file reads (`workspace.files.*`) are outside the endpoint table; the bridge reads delivered files from disk because it shares the host with the Harniverse runtime.
- Only the mux frames the bridge consumes are parsed; `session/queue`, `session/jobs`, projection, compaction, and `stream/error` frames are dropped.
- The mux reconnects but does not backfill events missed while the host was down beyond the cursor replay; a `bootId` change is reported for the owner to reconcile.
- HTTPS origins with a custom CA are not supported; the runtime trust store applies.
