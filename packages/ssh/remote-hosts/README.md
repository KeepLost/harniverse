# @deepseek-ai/dsh-remote-hosts

English | [中文](README.zh.md)

Reference for the local authoritative remote-host coordinator. `RemoteHosts` is the named and default `TypertRemoteService` at `ctx.remoteHosts`. `RemoteHostsProvider` is the Service Definition; this class is the Provider; Typert management clients and trusted local proxy plugins are Consumers. Required injections are `remoteHostSsh`, `credentials`, and `settings`. The SSH and credential implementations remain replaceable plugins.

## Configuration and ownership

`artifactsRoot` is a required absolute local directory containing native artifact directories named `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, or `win32-arm64`. Each selected directory must contain the [remote-server artifact](../../../apps/remote-server/README.md#artifact-and-build-commands), including its manifest and digest. Only platforms actually built need directories. `dshHome` overrides the local registry home; otherwise standard `DSH_HOME` resolution applies. `startupTimeoutMs` defaults to 60000 and `requestTimeoutMs` to 30000; both are positive integers at most 2147483647.

The local `remote-hosts.json` is `{ version: 1, hosts: HostRecord[] }`, with UUID-branded `RemoteHostId` values. It contains host configuration and credential references only. Runtime connection state is not persisted. The composing app owns exclusive local Harness-home access; registry writes serialize and atomically rename private temporary files. Host operations serialize per ID, not across unrelated hosts. Reload the plugin after external registry edits.

The remote `dshHome` is independent of the local one. It must be absolute in the selected remote platform's syntax. When omitted, the coordinator uses SSH SFTP `realpath('.')` plus `.dsh`; Windows `/C:/...` SFTP paths are normalized to `C:/...`. The remote app owns its home lease and refuses duplicate processes.

## Management API

The Remote namespace is `remoteHosts`. `list()` and `keyFilePicker()` require `harniverse.observe`; `upsert(input)`, `removeHost(id)`, `verify(input)`, `pickKeyFile()`, `connect(input)`, and `disconnect(id)` require `harniverse.administer`. Ordinary authorized local owners can manage hosts through these methods. Browser management must always target the original local host, even while viewing a remote workspace.

`removeHost` is the exported Remote name of the local `ctx.remoteHosts.remove(id)` method. The Client Gateway's namespace Service owns `remove` for unmounting, so a Remote method with that name cannot be mounted.

`upsert` replaces the complete configuration. Omit `id` to create; retain the returned ID to edit. Defaults are `port: 22`, `reverseMappings: []`, and `storeCredentials: false`. Editing a connected host requires disconnect. Required fields are `name`, `host`, `username`, `fingerprint`, `platform` (`linux`, `darwin`, `win32`), `architecture` (`x64`, `arm64`), and `authentication`. Unknown fields reject.

The authentication forms are `{ kind: "password", passwordRef? }`, `{ kind: "key", privateKeyRef?, keyPath?, passphraseRef? }`, and `{ kind: "agent", socket }`. Agent sockets or Windows named pipes are explicit. Reference names follow the credentials service's POSIX identifier format. A private key is either referenced content (`privateKeyRef`) or a host-local file path kept on the record (`keyPath`) — the path stays a plain string because it names a file on the machine the Host runs on, and the Host itself reads that file at use time; submitted secrets carry exactly one of `privateKey` or `privateKeyPath`.

`verify({ host, port?, username, secrets })` runs the connectivity test that must pass before a host is saved. It authenticates with the submitted credentials, accepts this attempt's host key, and runs one fixed probe, returning `{ fingerprint, platform, architecture }`.

`keyFilePicker()` reports which interaction the composition serves — `{ kind: 'native' }` when the host can open its own chooser, `{ kind: 'browse' }` when the browse directory-picker surface composes, and `{ kind: 'absent' }` otherwise (no picking interaction) — so clients render the matching affordance instead of guessing. It is the routing probe; `pickKeyFile()` is the `native` half. `pickKeyFile()` serves the login form's key-file affordance: it opens the host's native single-file chooser seeded at the operator's `~/.ssh` through `ctx.get('directoryPicker')` (the only optional injection — a composition without a `native` capability fails fast with `KEY_PICKER_UNAVAILABLE`, e.g. when the probe raced an unload) and returns `{ path }` — the picked file's host-local path, exactly what `AuthSecrets.privateKeyPath` stores; the field is absent when the operator cancels. The `browse` half is client-side: the key-directory flow slot's dialog lists directories on the machine the Host runs on, and a confirmed directory becomes the path's directory part (the operator completes the file name in the focused path input). Key credentials are host-local paths, never uploads: the Host reads the file itself whenever it uses the credential — at `verify` and `connect` time — capping at 64 KiB (`KEY_FILE_TOO_LARGE`); a vanished or unreadable file reports `KEY_FILE_READ_FAILED`; foreign chooser failures are contained as `KEY_PICKER_FAILED`.

The reported `fingerprint` is that connection's own observed host key, and the reported `platform` and `architecture` are what the target answered. They are the values `upsert` then stores: the recorded pin comes from a connection whose login already succeeded, and the detected target skips asking the operator to declare what the host already knows. Detection accepts POSIX `uname` answers first and retries through PowerShell for a Windows default shell; an answer naming no deployable platform or architecture fails the test. Preserved credentials are re-verified by a fresh test, so a pin change surfaces as a failed test with no stored acceptance to fall back on.

### Concrete UI submission

After a successful connectivity test, the UI submits this complete JSON argument, using the fingerprint and detected target that test reported. The example password is synthetic documentation data:

```json
{
  "input": {
    "name": "Build workstation",
    "host": "build.example.org",
    "port": 22,
    "username": "runner",
    "fingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "platform": "linux",
    "architecture": "x64",
    "dshHome": "/home/runner/.dsh-remote",
    "authentication": { "kind": "password" },
    "secrets": { "kind": "password", "password": "documentation-only-password" },
    "storeCredentials": true,
    "reverseMappings": [
      { "localHost": "127.0.0.1", "localPort": 11434, "remoteOriginalOrigin": "http://127.0.0.1:11434" }
    ]
  }
}
```

Send `POST /api/remoteHosts/upsert` using the existing Connection envelope: set `type` to `client-request`, `rpcId` to a unique request ID, `method` to `remoteHosts/upsert`, and `payload.args` to the argument object above. The response is a `server-response` with the matching `rpcId` and `result: { ok: true, value: RemoteHostView }`, or the standard error result. Generated `./remote` clients own this envelope. For key input, use `authentication: { kind: "key" }` and `secrets: { kind: "key", privateKeyPath, passphrase? }` (a host-local path — the Host reads the file at use time) or `secrets: { kind: "key", privateKey, passphrase? }` (inline content, e.g. pasted text); only `storeCredentials: true` persists the login, and the stored record then keeps `keyPath` or `privateKeyRef` respectively. Password, private key, and passphrase values never appear in returned host views, and a saved path never leaves the Host.

For a host whose returned ID is `84fbdabb-7814-4d13-a19a-5afeb7b1eb50`, this is a complete saved-login request to `POST /api/remoteHosts/connect`:

```json
{"type":"client-request","rpcId":"host-connect-1","method":"remoteHosts/connect","payload":{"args":{"input":{"id":"84fbdabb-7814-4d13-a19a-5afeb7b1eb50"}}}}
```

For an unsaved login, first upsert without `secrets`, then call `connect({ id, secrets: { kind: "password", password }, storeCredentials: false })`. `connect({ id })` resolves saved references. `connect` with `storeCredentials: true` saves supplied secrets before dialing. Repeated concurrent connects coalesce; the first admitted input wins. Calling connect while connected repeats settings/credential synchronization. Upsert rejects secrets without explicit storage consent instead of silently retaining or discarding them.

`list()` returns records plus `state` (`offline`, `connecting`, `deploying`, `connected`, `error`) and an optional fixed, sanitized `error`. Poll it for progress. It exposes neither local tunnel ports nor access tokens. No untyped event is emitted.

## Deployment, authentication, synchronization

The coordinator checks the manifest digest, platform, architecture, paths, every local file hash, and portable in-tree links before transfer. Links are materialized as checked regular-file trees, avoiding Windows symlink privileges. Uploads enter a private unique staging directory, then become `server/releases/<manifest-digest>` only after verification. Existing releases are reverified, including rejection of extra files. Partial staging directories are not executed or reused.

Before running copied Node, Linux uses `sha256sum`, macOS uses `shasum -a 256`, and Windows uses PowerShell `Get-FileHash`. The verified copied Node then verifies the entire transferred tree and restores executable bits. A failed native hash command fails closed. No source checkout, global Node, package manager, or remote dependency installation is used. Native hashing tools and trusted private path ancestors are prerequisites; a same-user adversary who can replace files during execution is outside this trust boundary.

POSIX startup uses quoted `nohup env` with redirected stdin/stdout/stderr. Windows uses encoded PowerShell: `Win32_Process.Create` with a detached bootstrap outside the SSH process job, then `Start-Process` with explicit working directory, arguments, environment, and log paths. The WMI return code is checked. Windows policy must permit that operation. Neither disconnect nor plugin unload kills the remote process.

Each local host ID owns random AES-256 material and a P-256 signing private key stored only through local `ctx.credentials` references. The copied Node bootstraps an API-client owner grant through the existing authentication registry API using stdin JSON. Reuse requires the deterministic grant name, matching public key, active state, and all required capabilities. Conflicts fail; grants are never silently replaced. Private signing material is never transmitted. The AES key crosses only authenticated runtime RPC for unlock.

Discovery validates `server/endpoint.json`. A live PID must answer authenticated runtime status with the same boot ID, platform, and architecture. A live but mismatched or unauthenticated endpoint fails without starting another process. Absent/dead discovery starts the detached app and polls within the startup deadline. The shipped app's HTTP loopback endpoint is supported; custom HTTPS discovery fails until certificate-trust integration exists.

The SDK `GrantAccess` signs challenges as SHA-256 IEEE-P1363 and coalesces access-token renewal. Runtime calls use the real Connection/Typert JSON envelope. After unlock, the coordinator sends a complete credential replacement and complete resolved local model/search sections. Resolved sections deliberately carry local composition defaults; configured model/search origins matching a reverse mapping are rewritten to that mapping's allocated remote loopback port before synchronization. Omitted namespaces reset remotely through the runtime API. Only fields marked `role('credential-ref')` in supported registered settings schemas are resolved. Objects, dictionaries, arrays, and intersections recurse; ambiguous reference-bearing unions/transforms reject. Unrelated local secrets and coordinator-owned references are excluded. Settings sync is per-namespace, not transactional; retry connect to converge after failure.

## Same-process proxy and reverse mapping Consumers

Search schemas also permit literal `apiKey` secrets beside `apiKeyEnv`. Synchronization removes those literal fields from remote settings and puts their effective values under the corresponding encrypted credential references. Conflicting literal values sharing a reference and unsupported secret layouts fail closed, so the coordinator does not persist submitted search keys in remote plaintext settings.

`request(id, path, init?)` is deliberately not a Remote method. It accepts a connected host and a same-origin `/api/` path, injects a current remote token, strips local browser authorization/cookies/origin, and refuses redirects and `remoteHosts` management paths. It returns the `Response`, including a stream body. `openWebSocket(id, path, signal?)` applies the same path fence and Access Token to a remote event socket; `authentication(id)` exposes only the last non-secret remote response identity for expected-principal translation. The local proxy must authorize every caller and operation before using these owner-authority transports. It must preserve the original local management route.

Every reverse mapping explicitly names `localHost`, `localPort`, and an exact HTTP(S) `remoteOriginalOrigin` without path, credentials, query, or fragment. No implicit localhost forwarding exists. `reverseMappings(id)` returns those same records plus each allocated remote loopback `remotePort`, only to trusted same-process Consumers. During synchronization, matching origin strings in the selected model/search namespaces become `http(s)://127.0.0.1:<remotePort>` while retaining their path. Provider traffic therefore uses only the explicitly configured reverse mapping.

`disconnect` closes SSH and all forwards. Remote agents, encrypted state, and unlocked credentials persist until remote process shutdown. `removeHost` additionally forgets the local record; it does not revoke remote grants or erase remote files. Coordinator-generated credential references are retained for deliberate recovery/cleanup, including replaced login references. Never delete the AES/signing references while a remote home still needs them.

## Verification

From the repository root, using installed executables:

```sh
node_modules/.bin/vitest run --config packages/ssh/remote-hosts/vitest.config.ts
node_modules/.bin/tsc -p packages/ssh/remote-hosts/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/tsx packages/ssh/remote-hosts/check-tests.ts
node_modules/.bin/oxlint --config .oxlintrc.json packages/ssh/remote-hosts
node_modules/.bin/tsc -p packages/ssh/remote-hosts/tsconfig.json --incremental false --composite false
node_modules/.bin/tsx packages/ssh/remote-hosts/build-typert.ts
```

Then run `../../../node_modules/.bin/tsdown --config tsdown.config.ts` from this package directory. Source/test checks require installed declared peers; `check-tests.ts` includes the new runtime/encrypted-provider sources without rebuilding them. The [tests](tests/) include Loader composition, real local authenticated runtime HTTP, native Linux deployment/hash execution, mocked SSH boundaries, strict generated Remote schemas, and renewal concurrency. Fixtures dispose every local server and isolated home.

## Model Experience

None, as this coordinator registers no tools, prompts, or Session events; existing remote plugins own model-visible work while synchronized settings and selected credentials determine their configuration.

#### KV Cache effect

No direct prefix changes; existing model-provider settings govern cache behavior.

## Known Limitations and Deferred Work

- Shared lockfile, Host aggregate, source aliases, bundles, root build, catalogs, and central Agent Note registration are external integration responsibilities. This package-only delivery does not edit them.
- Local credential storage security is the selected writable provider's responsibility. The remote encrypted provider is read-only to `set`, so it cannot serve as the local writable authority without a separate writable encrypted implementation.
- Real macOS/Windows OpenSSH deployment and disconnect persistence require their native hosts. Windows CIM detachment depends on account policy. Package tests do not establish those native guarantees or full artifact startup on all platforms.
- There is no automatic reconnect, live settings subscription, remote upgrade/restart, grant revocation, credential garbage collection, or stale release cleanup. Explicit connect synchronizes; an existing live app remains on its running release.
