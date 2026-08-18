# dsh-authentication-local

English | [中文](README.zh.md)

Local public-key Grant Provider for [inbound authentication](../authentication/README.md). `$DSH_HOME/auth/grants.json` stores P-256 public keys, capability sets, revisions, and optional lifetimes. Private keys stay on devices and API clients. Challenges, bearer Access Tokens, and browser sessions exist only in process memory.

## Management

```sh
dsh auth device list
dsh auth device approve <request-id> --profile owner
dsh auth grant list
dsh auth grant revoke <grant-id>
dsh auth client add automation --public-key <base64url-spki> --capability harniverse.observe harniverse.operate
dsh auth client revoke <grant-id>
```

An authenticated instance may start without Grants. Its static browser shell accepts enrollment requests, but business APIs remain sealed until local CLI approval creates the first owner and seal again whenever no active owner remains. Pending requests have a durable global bound and a per-peer creation limit. An owner browser can manage pending requests and Grants at `/auth/manage`. Device Grants use persistent non-exportable browser keys; temporary device keys remain in memory and Grants are limited to 60 minutes with a 15-minute idle timeout. API clients register a public key locally and use signed challenge exchange. The owner management route can issue one nonrenewable Access Token for at most 15 minutes without `harniverse.authorize`.

`$DSH_HOME/auth/tokens.json` is rejected as an unsupported legacy format. There is no migration or bearer compatibility mode.

## Config

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Grant registry, access log, and lease root. |
| `mode` | `authenticated` | `authenticated` or explicit loopback-only `bypass`. |
| `watch` | `true` | Enable low-latency filesystem observation; periodic reconciliation always runs. |
| `debounceMs` | `100` | Registry watcher settle window. |
| `accessTokenTtlMs` | 10 minutes | Access Token and browser-session lifetime, capped at 15 minutes. |
| `challengeTtlMs` | 60 seconds | Single-use challenge lifetime, capped at 5 minutes. |
| `enrollmentTtlMs` | 10 minutes | Pending lifetime and fresh approved-receipt polling lifetime, capped at 15 minutes. |
| `maxPendingEnrollments` | `128` | Durable unexpired pending-enrollment limit. |
| `enrollmentRequestLimit` | `5` | Requests accepted from one direct peer per counting window. |
| `enrollmentRequestWindowMs` | `60000` | Per-peer enrollment counting window. |
| `maxEnrollmentPeerKeys` | `4096` | Process-memory peer counters retained for enrollment. |
| `maxAccessTokens` | `4096` | Process-memory Access Token limit. |
| `maxAccessTokensPerGrant` | `64` or the global limit when lower | Process-memory Access Token limit per exact Grant revision. A full global ledger rejects a new Grant rather than evicting another Grant. |
| `maxChallenges` | `4096` | Pending challenge limit. |
| `maxChallengesPerGrant` | `16` or the global limit when lower | Pending challenge limit per exact Grant revision. |
| `maxBrowserSessions` | `1024` | Process-memory browser-session limit. |
| `maxBrowserSessionsPerGrant` | `16` or the global limit when lower | Browser-session limit per exact Grant revision. |
| `reconcileIntervalMs` | `5000` | Mandatory periodic registry reconciliation. |
| `accessLogMaxBytes` | 10 MiB | Active JSONL size before rotation. |
| `accessLogMaxFiles` | `5` | Rotated files retained. |
| `authFailureLimit` | `10` | Invalid credentials allowed per channel and direct peer in one window. |
| `authFailureWindowMs` | `60000` | Invalid-credential counting window. |
| `authFailureBlockMs` | `300000` | Block duration after the failure limit. |
| `maxAuthFailureKeys` | `4096` | Maximum limiter states retained in memory. |

## Storage and revocation

Registry and access files are `0600` under `0700` directories on POSIX. Registry writes use atomic replacement under a nonce-owned cross-process lock, and a failed mandatory audit append rolls the mutation back. Browser credentials are published only after their login audit succeeds. Enrollment approval and Grant revocation are serialized with registry readers. Every admission rechecks the durable Grant revision, expiry, and idle state; credential expiry is capped by the Grant's earlier absolute or idle deadline. A registry failure or loss of the final active owner clears all process credentials, rejects business admission, and closes sockets until reconciliation finds an active owner. Exact Grant revocation removes matching challenges, Access Tokens, browser sessions, and WebSockets.

The Provider acquires `$DSH_HOME/runtime/inbound-authentication.lease` before WebServer bind, so authenticated and bypass instances are mutually exclusive for one home. `$DSH_HOME/auth/access.jsonl` records privacy-minimal instance, enrollment, Grant, challenge, login, and admission outcomes. It never records request bodies, query strings, Authorization/Cookie values, private keys, signatures, Access Tokens, browser-session values, or Harness session ids.

## Model Experience

None, as the Provider controls external admission without changing model operations.

#### KV Cache effect

None; authentication material never enters model input.

## Known Limitations and Deferred Work

- Browser sessions and Access Tokens are process memory and require signed exchange after restart.
- Access records are local rotated JSONL, not a remote audit sink.
- POSIX mode checks have no Windows ACL equivalent.
