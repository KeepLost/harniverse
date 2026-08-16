# dsh-authentication-local

English | [中文](README.zh.md)

Local named-token provider for [inbound authentication](../authentication/README.md). It stores only token lookup ids and SHA-256 digests in `$DSH_HOME/auth/tokens.json`; `add` and `reset` return the generated value once, while list, diagnostics, and access records expose only the non-secret name and timestamps.

## Token management

```sh
dsh auth token add laptop
dsh auth token reset laptop
dsh auth token delete laptop
dsh auth token list
```

Names are unique and match `^[a-z0-9][a-z0-9._-]{0,63}$`. Reset and delete revoke only the named token's browser sessions and WebSockets. Deleting the final token seals a running authenticated instance without stopping it; adding a token restores admission. An authenticated process cannot start with an empty registry.

## Config

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Registry, log, and lease root. |
| `mode` | `authenticated` | `authenticated` or explicit `bypass`. |
| `watch` | `true` | Observe token management changes. |
| `debounceMs` | `100` | Registry watcher settle window. |
| `sessionTtlMs` | 24 hours | In-memory browser session lifetime. |
| `maxBrowserSessions` | `1024` | Process-memory session limit; a new login evicts the oldest live session at capacity. |
| `reconcileIntervalMs` | `5000` | Registry polling fallback when filesystem watch events are missed. |
| `accessLogMaxBytes` | 10 MiB | Active JSONL size before rotation. |
| `accessLogMaxFiles` | `5` | Rotated files retained. |

## Storage and lifecycle

Registry and access files are `0600` under `0700` directories on POSIX. Registry writes use atomic replacement under a nonce-owned cross-process lock. Filesystem watch events trigger targeted revocation, periodic reconciliation covers missed events, and an authenticated watcher or registry-read failure rejects new admission and closes current sessions and sockets until reconciliation succeeds. Bypass does not depend on registry freshness. The process acquires `$DSH_HOME/runtime/inbound-authentication.lease` before the WebServer binds, so authenticated and bypass instances are mutually exclusive for one home; stale process owners are reclaimed without deleting a replacement owner's marker.

`$DSH_HOME/auth/access.jsonl` contains serialized, rotated JSON records for instance, token-management, login, and admission outcomes. Records may contain peer addresses and token names, but never request bodies, query strings, Harness session ids, Authorization/Cookie values, token ids, digests, or browser-session secrets. An accepted network admission becomes a rejection when its access record cannot be committed.

## Model Experience

None, as the provider controls whether an external client can reach model-facing operations without changing them.

#### KV Cache effect

None; token and browser-session material never enters model input.

## Known Limitations and Deferred Work

- Browser sessions are process memory and require login again after restart.
- Access records are local JSONL with size rotation, not a remote audit sink.
- POSIX mode checks have no Windows ACL equivalent.
