# `@deepseek-ai/dsh-ssh`

English | [中文](README.zh.md)

Owns the OpenSSH connection, helper integrity check, bounded RPC transport, execution-world descriptor, and machine-owned MCP/Skill/Hook inventory. The helper lease and process registry are connection-owned and close on transport loss.

The `profile` configuration is an immutable captured permission record. It selects machine inventory members; it cannot select local paths, local credentials, or live Cordis mutation authority.

## Model Experience

None, as host aliases, authentication, and stream capabilities are private deployment details; consumers own every model-visible operation.

#### KV Cache effect

None; the transport, lease, and inventory facts never enter model input.

## Known Limitations and Deferred Work

- **POSIX remotes only** — the helper relies on POSIX exec, signal, and pty semantics; Windows OpenSSH remotes stay out of scope until a consumer needs them.
- **Deployment-owned helper installation** — no remote upload or install path exists; `bootstrapPath`/`bootstrapHash` must be pre-staged on the execution machine, and a digest mismatch fails the connection closed.
- **One bounded control channel per connection** — there is no session multiplexing, pooling, or reconnect/resume; transport loss invalidates the connection together with its leases and remote process range.
