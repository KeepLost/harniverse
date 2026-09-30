# @deepseek-ai/dsh-remote-runtime

English | [中文](README.zh.md)

`RemoteRuntime` is the default-exported `TypertRemoteService` at `ctx.remoteRuntime`. It requires `agents`, `authentication`, `credentials`, `settings`, and `webServer`. The credentials service must be the actual [`EncryptedCredentialProvider`](../../credentials/credentials-encrypted/README.md) instance; structural substitutes are rejected. Startup also rejects authentication bypass and listeners other than `127.0.0.1`.

## Control contract

The generated Remote namespace is `remoteRuntime`. `./typert` supplies Host metadata and `./remote` supplies the generated client contribution.

| Method | Wire arguments | Capability | Result |
| --- | --- | --- | --- |
| `status()` | `{}` | `harniverse.observe` | `{ locked, bootId, platform, arch }` |
| `unlock(key)` | `{ key }` | `harniverse.administer` | void |
| `replaceCredentials(snapshot)` | `{ snapshot }` | `harniverse.administer` | void |
| `syncSettings(snapshot)` | `{ snapshot }` | `harniverse.administer` | void |

`key` is the encrypted provider's canonical unpadded base64url encoding of 32 random bytes. The credential snapshot is `Record<string, string>`: replacement deletes omitted references, including every reference for `{}`. Settings use the existing Session `JsonValue` type rather than `unknown`, so Typert emits strict recursive JSON schemas. Unlock first, then replace credentials and synchronize settings; begin agent work after both synchronization calls succeed. A rejected key leaves the provider locked, or preserves an already unlocked session as specified by the provider.

## Ownerless exit

Every authenticated Remote call refreshes an owner-liveness lease. When no owner RPC arrives within `Config.ownerlessExitMs` (default `45_000`), the runtime emits `remote-runtime/ownerless` once per starvation episode; a later owner contact re-arms the next one. The remote-server app subscribes and terminates itself through the executable's graceful stop, so a dead local instance never leaves an orphan holding the exclusive home lease and rejecting successors with `REMOTE_RPC_REJECTED`. The coordinating host session keeps the lease fresh with periodic `status` keepalives (`remoteHosts.heartbeatIntervalMs`, default `10_000`).

`assertUnlocked(): void` is a concrete same-process admission check for consumers. It throws while locked or disposed and does not wait for reconnect. The plugin installs it through `ctx.agents.registerAdmission()`; disposing the plugin removes that policy. New creation, restoration, and fork operations are subject to the driver's admission check. Disconnecting a browser or SSH transport does not lock credentials or dispose agents. The encrypted provider owns key erasure on its own disposal, and a new process starts locked even when encrypted storage exists.

## Settings synchronization

The snapshot contains complete, unredacted local **user sections**, keyed by namespace. The supported names are `llm-deepseek`, `llm-pi-ai`, `agent-default-model`, `model-profiles`, `model-routes`, `web`, `web-search-deepseek`, `web-search-exa`, `web-search-perplexity`, `web-search-tavily`, `web-search-brave`, `web-search-kagi`, and `web-firecrawl`.

Each present namespace must be registered remotely and contain an object. Unknown, unrelated, and unregistered namespaces reject before writes. Each supported registered namespace is replaced through `ctx.settings.replace()`, preserving its owner's schema and semantic validation. Omitted namespaces receive `{}`; omitted fields re-inherit composition values and schema defaults. Unrelated settings are untouched. Supply resolved local values explicitly when local composition defaults must override remote defaults.

Concurrent snapshots are detached at call time and serialized. Namespace commits remain independent: validation or persistence failure can follow earlier committed sections. Retry the same complete snapshot to converge; there is no cross-namespace transaction in the settings provider. Do not build a snapshot from redacted UI descriptors.

## Endpoint discovery

`Config.dshHome` overrides the discovery home; otherwise the plugin uses the standard `DSH_HOME` resolution. The server app gives credentials and discovery the same home and holds the shared boot library's exclusive home lease.

Startup atomically publishes `server/endpoint.json` with `{ version: 1, host: "127.0.0.1", port, protocol, pid, bootId }`. The port is the bound OS-assigned port; protocol is `http:` or `https:`. The file contains no key, credential, token, or signing material. POSIX permissions are `0700` on `server/` and `0600` on the file. Windows applies a protected current-user-only inheritable DACL with the system PowerShell before writing. Symlinked server directories are rejected. Disposal removes the descriptor only when its boot identity and PID still match this runtime.

## Model Experience

None, as this Host plugin adds no prompt, tool, message, or model request; synchronized model and search settings take effect through their existing owning plugins.

#### KV Cache effect

None directly; the plugin does not assemble model input.

## Known Limitations and Deferred Work

- Forward-dependent work waiting for reconnect belongs to the coordinator's gateway extension; `assertUnlocked()` provides immediate admission rejection only.
- Discovery assumes the composing app holds exclusive home ownership. Crashes can leave a descriptor; the SSH consumer must verify process identity and boot identity before using it.
- Windows DACL and native macOS/Windows deployment checks require their respective hosts.
