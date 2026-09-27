# @deepseek-ai/dsh-remote-hosts-ssh

English | [中文](README.zh.md)

Pinned SSH transport for independently managed remote Harniverse hosts. `RemoteHostSsh` is both the named and default service-class export; it mounts on `ctx.remoteHostSsh`. Consumers declare `inject: ['remoteHostSsh']` and use the exported `RemoteHostSshProvider` contract. A replacement Cordis service can provide the same key. The concrete service combines the Service Definition and Service Provider roles; a coordinator consumer owns host settings, user consent, credential storage, deployment and remote process lifecycle. See the [architecture](../../../docs/architecture.md#capability-seams).

## Connection and trust

`open(config, authentication, signal?)` returns a `RemoteHostSshConnection`. `config` contains `host`, `username`, optional `port` (default `22`), and a required canonical OpenSSH `fingerprint` in `SHA256:<43-character unpadded base64>` format. The provider hashes the raw host-key bytes and requires an exact pin match before authentication. A missing, malformed or mismatched pin never falls back to automatic acceptance or a known-hosts file. Each new connection verifies its own approved pin.

Authentication is one of:

- `{ kind: 'password', password }` for explicit password authentication.
- `{ kind: 'key', privateKey, passphrase? }` for private-key contents, including encrypted keys. Paths are not substituted for key contents.
- `{ kind: 'agent', socket }` for an explicitly selected OpenSSH agent Unix socket or Windows named pipe. Agent forwarding is disabled; the transport owns these local sockets, including during cancelled authentication.

`probe({ host, port?, username }, signal?)` returns the observed SHA256 fingerprint. It rejects the key, closes the connection and sends no authentication request. Its result is untrusted observation: the UI must obtain independent verification and explicit per-host approval before supplying the fingerprint to `open`. The provider never stores approval or credentials.

## Connection API

All paths and command strings are passed to the SSH server unchanged. The provider does not select a shell, quote commands, normalize remote paths or install a helper.

| Method or property | Contract |
|---|---|
| `exec(command, input?, signal?)` | Sends an exec request without a PTY; input is a string or Buffer and stdin receives EOF. Returns Buffer fields `stdout` and `stderr`, a nullable numeric `exitCode`, and a nullable string `signal`. Nonzero exit status is a result, not an exception. Missing exit metadata stays `null`; signal names retain ssh2's representation. |
| `upload(localPath, remotePath, signal?)` | Opens/prepares the destination with mode `0600`, verifies `fchmod`, then transfers through SFTP `fastPut`. Existing files are overwritten. Empty uploads also receive private mode. |
| `readFile(path, signal?)` | Reads bounded bytes over SFTP and returns a Buffer; overflow rejects without returning partial data. |
| `realpath(path, signal?)` | Returns the server's canonical path. |
| `mkdir(path, signal?)` | Creates one directory with mode `0700`; existing directories remain server errors. |
| `forward(remoteHost, remotePort, signal?)` | Opens a local ephemeral listener on `127.0.0.1`; each accepted socket uses `forwardOut` to the fixed remote destination. Returns `{ port, close() }`, where `port` is local. |
| `reverse({ remotePort?, localHost, localPort }, signal?)` | Requests `forwardIn` on remote `127.0.0.1` only. Omitted/zero remote port selects an ephemeral port. Returns `{ port, close() }`, where `port` is remote. |
| `signal` | Aborts when the connection becomes unusable. Its reason is a sanitized `RemoteHostSshError`. |
| `closed` | Resolves after the SSH socket, owned channels, listeners, agent sockets and in-flight upload callbacks have drained. |
| `dispose()` | Idempotently closes this transport and awaits `closed`. No remote agent kill, close RPC or process signal is sent. |

Reverse forwarding authorizes only the exact remote address/port registered on that connection. Each mapping captures its configured local destination before binding. Wrong addresses, unregistered ports and mappings belonging to another connection are rejected. Closing a handle removes admission before draining accepted sockets. The consumer must call `reverse` only with destinations authorized in that host's settings; this provider has no global destination registry or implicit forwarding rules.

## Bounds and failures

Plugin `Config` accepts the following positive integer limits, each at most `2147483647`:

| Setting | Default | Applies to |
|---|---|---|
| `connectTimeoutMs` | `30000` | TCP/SSH establishment, authentication and fingerprint probes. |
| `operationTimeoutMs` | `120000` | Each command, complete SFTP operation, forwarding setup, accepted-socket setup and forwarding-handle cleanup. |
| `maxOutputBytes` | `8388608` | Combined retained stdout and stderr bytes per command. |
| `maxReadBytes` | `4194304` | Complete returned file bytes per read. |

SSH keepalives run every 10 seconds with three unanswered probes allowed. Established forwarding streams live until their handle or connection closes; the operation deadline is not an idle timeout.

An already-aborted signal rejects before admission without closing an existing connection. Once admitted, cancellation, an operation deadline or a byte-limit failure closes the entire owning connection, including concurrent operations. Signals supplied to `open`, `probe`, `forward` or `reverse` cover establishment only. Use `dispose` or the returned forwarding handle to close resources after establishment. Failed remote requests can reject while leaving the connection usable; transport failures invalidate it.

Failures use `RemoteHostSshError` with codes `INVALID_CONFIG`, `INVALID_ARGUMENT`, `HOST_KEY_MISMATCH`, `CONNECT_FAILED`, `OPERATION_FAILED`, `CLOSED`, `ABORTED`, `TIMED_OUT` or `LIMIT_EXCEEDED`. Messages and causes never copy upstream errors, credentials, commands, paths or caller abort reasons. Exec output is deliberately caller-visible data and can itself contain secrets; consumers own its storage and presentation.

Plugin unload stops new admission and awaits all connecting or established transports. Disposal releases local transport resources only. Consumers must launch persistent remote Harniverse processes using the platform's detached/service mechanism; an SSH server can terminate a foreground session when its channel closes.

## Dependencies and verification

The new `ssh2` dependency provides SSH authentication, key parsing, SFTP and forwarding without a remote helper. Node's crypto/net modules provide pinning and owned sockets; `@types/ssh2` supplies development types. The existing helper-managed SSH execution world is not used because its disconnect lifecycle owns remote child cleanup.

The [tests](tests/) use a real local ssh2 server and process-local RSA keys generated with Node crypto. They exercise password, plain/encrypted key and explicit-agent authentication, failed pinning, pre-authentication probes, SFTP privacy/bounds, forwarding authorization, cancellation, deadlines, plugin unload and a Loader-loaded `cordis.yml` composition. They use no configured host, real user keys or model credentials.

From the repository root, with declared dependencies available:

```sh
node_modules/.bin/vitest run --config packages/ssh/remote-hosts-ssh/vitest.config.ts
node_modules/.bin/tsc -p packages/ssh/remote-hosts-ssh/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/tsc -p packages/ssh/remote-hosts-ssh/tsconfig.tests.json
node_modules/.bin/oxlint --config .oxlintrc.json packages/ssh/remote-hosts-ssh
```

A package-only build uses `node_modules/.bin/tsc -p packages/ssh/remote-hosts-ssh/tsconfig.json --incremental false --composite false`, followed by the local tsdown configuration from this package's directory. With runtime dependency links available, `node packages/ssh/remote-hosts-ssh/tests/built-smoke.mjs` exercises the published JavaScript and default export under plain Node against an ephemeral SSH server. Workspace dependencies must already have their declaration/build outputs; these checks do not rebuild them.

## Model Experience

### Transport operations

#### What the model sees

This provider registers no tools, prompts, model fields or Session events. Consumers own any model-visible projection of transport results.

#### Token effect

The provider adds no request or response tokens directly.

#### KV Cache effect

The provider does not change model request prefixes or invalidate an already-reusable prefix. Consumer projections and model-provider cache behavior remain outside this package.

## Known Limitations and Deferred Work

- Workspace integration requires installing the declared dependencies and adding the package to the Host compiler aggregate and selected consumer composition. This independent package does not update root aggregates, bundles, the shared lockfile or generated catalogs.
- Transport code is platform-neutral for Linux, macOS and Windows. Actual OpenSSH/SFTP server policy, shell commands, remote daemon detachment and Windows ACLs require platform integration tests; a local ssh2 fixture does not prove those deployments.
- Uploads require a caller-owned private directory with trusted path components. They are non-atomic, may leave partial files on failure and do not defend against another writer replacing paths. Servers that cannot honor private-mode operations cause upload failure; mode bits alone do not prove Windows ACL privacy.
- Agent authentication supports the explicit OpenSSH socket protocol, not Pageant/Cygwin discovery, SSH config aliases, jump hosts or keyboard-interactive authentication.
- The package performs no automatic reconnect, credential persistence, host-key approval, deployment, remote process supervision or application health probing. Those policies belong to the coordinator consumer.
