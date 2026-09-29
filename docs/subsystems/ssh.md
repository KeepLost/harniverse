# SSH

English | [中文](ssh.zh.md)

The [SSH provider family](../../packages/ssh/README.md) supplies one remote filesystem/process world through a deployment-owned OpenSSH connection. The Harness, model transport and Session storage remain on the host. The family implements the existing filesystem, subprocess and sandbox APIs; it introduces no SSH-specific model tools.

## Execution coordinates

Filesystem identities, executable lookup, process cwd, sandbox workspace roots and language-server file URLs refer to the SSH host. Providers canonicalize paths where the files exist, preserving filesystem interpretation of `symlink/..`. The policy resolver carries absolute execution-world spelling without trying to resolve remote paths on the Harness host.

`processPath()` supplies a path usable by the paired subprocess provider. Installing a remote artifact does not make an arbitrary host path portable, so consumers requiring an installed executable or bootstrap must supply and verify the remote artifact explicitly through the connection's paired digest fields.

## Transport and trust

All helper traffic — administrative RPC, process stdin/stdout/stderr, and terminal streams — rides bounded frames on one shared control channel over the SSH exec streams; OpenSSH authenticates both ends, so the frame protocol carries no second credential surface. Process output is pulled through bounded chunks, and stdin and terminal input are backpressured, so a stalled consumer cannot grow unbounded buffers on either side.

Deployment authentication, installed artifact verification and the captured-Profile check belong to [`dsh-ssh`](../../packages/ssh/ssh/README.md). The helper executes filesystem and process requests with trusted local providers on the remote machine. SSH is a transport; the selected remote sandbox provider enforces file effects.

## Process lifetime and cancellation

A process handle reports its direct outcome through `done`; `waitForExit` observes the remote managed range after it. Terminal operations retain the asynchronous shared API, including remote resize. Administrative deadlines bound individual RPC observations; they do not replace the execution deadline chosen by a Bash or PTC runtime consumer. Remote waits can remain pending while other requests progress. SSH loss invalidates pending operations; helper EOF, signals and lease expiry start remote cleanup. The client reports unconfirmed outcomes honestly and never reconnects to replay a possibly executed action.

## Machine-owned inventory and Profile restriction

The machine owns its MCP servers, Skills and Hooks: the helper enumerates them from the remote deployment, and no client request can add, remove, or rewrite them. The connection mounts only the members an immutable captured Profile revision selects — omitted servers, Skills and Hooks are denied — and the capture rejects local Cordis authority, local paths, and local credentials. Consumers enforce the same restriction on their registrations, so a transport loss or a Profile mismatch unmounts exactly what the capture admitted.

## Composition scope

Headless records and checks Session cwd through the mounted filesystem provider. Remote FS, Bash, terminal and LSP consumers can therefore share those coordinates. The connection exposes the verified remote Node executable and, when configured, the digest-paired preinstalled PTC entry, so a fresh-process runtime can launch through the paired subprocess provider without borrowing a Host path. Web workspace views that assume host filesystem access need separate integration; replacing providers alone does not make those views remote-aware.

## Connection API

```ts type-equiv
/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Absolute remote Node executable; a completed handshake proves it runnable in the execution world. */
  node: string
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Optional local OpenSSH configuration, owned by the deployment. */
  sshConfig?: string
  /** Optional preinstalled built PTC entry, paired with its expected digest. */
  bootstrapPath?: string
  /** SHA-256 of bootstrapPath; both fields must be supplied together. */
  bootstrapHash?: string
  /** Immutable Profile selection, captured before this connection is mounted. */
  profile: CapturedRemoteProfile
  /** Connection and administrative-request deadline. */
  requestTimeoutMs?: number
  /** Remote helper lease; heartbeat loss starts remote managed cleanup. */
  leaseMs?: number
}
```

```ts type-equiv
/** The immutable world facts a Host learns: signed descriptor plus captured profile and inventory. */
interface WorldDescription {
  readonly descriptor: ExecutionWorldDescriptor
  readonly profile: CapturedRemoteProfile
  readonly inventory: MachineInventory
}
```

```ts public-api
/** Loss invalidates this connection. A new connection captures a new remote revision. */
declare class SshConnection extends Service {
  static Config: schema<Config>;
  /** Handshake settlement: resolves with the verified helper hello or fails the connection. */
  readonly ready: Promise<Hello>;
  constructor(ctx: Context, config: Config);
  /**
   * Issue one bounded RPC against the connected helper.
   * @param method - the protocol method name.
   * @param params - its validated payload.
   * @param result - the schema every successful reply body must satisfy.
   * @param signal - cancellation for this request alone.
   * @param wait - true to use the connection lifetime instead of the administrative request timeout.
   * @returns the parsed reply body.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>;
  /**
   * This description is pinned for the connection, including the captured Host Profile revision.
   * @returns the immutable world descriptor the helper verified at connect.
   */
  async describeWorld(): Promise<WorldDescription>;
  /** Verified remote Node executable for the paired PTC runtime. */
  get nodeExecutable(): string;
  /** Verified preinstalled PTC entry; unconfigured runtimes fail before program execution. */
  get bootstrapPath(): string;
  /** Notify consumers so their registrations disappear when transport authority is lost. */
  get signal(): AbortSignal;
  /** Join helper cleanup when reachable, then close and join the owned OpenSSH process. */
  dispose(): Promise<void>;
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxremotehosts--remotehostsprovider"></a>

### `ctx.remoteHosts` — `RemoteHostsProvider`

Definition consumed by management UIs and trusted same-process proxy plugins.

```ts cordis-catalog
/**
 * List configured hosts with their current connection state.
 * @returns the current view of every configured remote host.
 */
list(): Promise<RemoteHostView[]>

/**
 * Create or replace one host configuration and optionally persist credentials.
 * @param input - complete host configuration and optional credential references.
 * @returns the saved host with its current connection state.
 */
upsert(input: UpsertHostInput): Promise<RemoteHostView>

/**
 * Remove one host configuration and its local credential references.
 * @param id - local registry identity of the host to remove.
 */
remove(id: RemoteHostId): Promise<void>

/**
 * Test one SSH target end to end and report what the tested connection proved.
 * @param input - target and explicit credentials for the test.
 * @returns the observed fingerprint and detected platform when authentication succeeds.
 */
verify(input: VerifyHostInput): Promise<ConnectivityResult>

/**
 * Open the host's native key-file chooser, seeded at the operator's `~/.ssh`.
 * Serves the `native` interaction only; clients route through `keyFilePicker` first.
 * @returns the picked file's host-local path, or nothing when cancelled.
 */
pickKeyFile(): Promise<PickKeyFileResult>

/**
  * Report which key-file picking interaction this composition serves.
  * @returns the composed directory-picker capability kind, `absent` when unserved.
  */
keyFilePicker(): Promise<KeyFilePicker>

/**
 * Connect to a configured host and synchronize its remote runtime.
 * @param input - host identity and optional one-shot credentials.
 * @returns the connected host view.
 */
connect(input: ConnectHostInput): Promise<RemoteHostView>

/**
 * Disconnect a host and close its owned transport resources.
 * @param id - local registry identity of the host to disconnect.
 */
disconnect(id: RemoteHostId): Promise<void>

/**
 * Proxy one permitted browser request to a connected remote host.
 * @param id - local registry identity of the destination host.
 * @param path - remote API path, including its query string.
 * @param init - optional request method, headers, and body.
 * @returns the remote HTTP response.
 */
request(id: RemoteHostId, path: string, init?: RequestInit): Promise<Response>

/**
 * Open one permitted event stream to a connected remote host.
 * @param id - local registry identity of the destination host.
 * @param path - remote WebSocket path, including its query string.
 * @param signal - optional cancellation for the opening handshake.
 * @returns the provider-owned WebSocket transport handle.
 */
openWebSocket(id: RemoteHostId, path: string, signal?: AbortSignal): Promise<unknown>

/**
 * Return local credential references without exposing credential values.
 * @param id - local registry identity of the host.
 * @returns secret-free authentication metadata.
 */
authentication(id: RemoteHostId): unknown

/**
 * Return active reverse mappings owned by one connected host.
 * @param id - local registry identity of the host.
 * @returns read-only active mapping descriptions.
 */
reverseMappings(id: RemoteHostId): readonly ActiveReverseMapping[]
```

Source: [`packages/ssh/remote-hosts/src/types.ts:119`](../../packages/ssh/remote-hosts/src/types.ts)

<a id="ctxremotehostssh--remotehostsshprovider"></a>

### `ctx.remoteHostSsh` — `RemoteHostSshProvider`

Consumer contract implemented by the Cordis service or a replacement provider.

```ts cordis-catalog
/** Verify the pin before authentication and return an owned connection.
 * @param config - pinned SSH target to connect to.
 * @param authentication - explicit credentials for this connection.
 * @param signal - optional cancellation for connection setup.
 * @returns an owned SSH connection.
 */
open(config: RemoteHostSshConfig, authentication: RemoteHostSshAuthentication, signal?: AbortSignal): Promise<RemoteHostSshConnection>

/** Authenticate against an unpinned target and run one probe under the key it accepted.
 * @param config - SSH target to test; its key is observed rather than compared.
 * @param authentication - explicit credentials for this attempt.
 * @param command - probe command run once after authentication.
 * @param signal - optional cancellation for the attempt.
 * @returns the accepted fingerprint and the probe's stdout.
 */
verify(config: RemoteHostSshTarget, authentication: RemoteHostSshAuthentication, command: string, signal?: AbortSignal): Promise<RemoteHostSshVerification>
```

Source: [`packages/ssh/remote-hosts-ssh/src/types.ts:88`](../../packages/ssh/remote-hosts-ssh/src/types.ts)

<a id="ctxremoteruntime--remoteruntime"></a>

### `ctx.remoteRuntime` — `RemoteRuntime`

Remote control provider. Browser and SSH connections never own its decrypted lifetime.

```ts cordis-catalog
/** Report lock state and process identity without credential names or values.
 * @returns the current runtime status.
 */
@Remote({ requiredCapability: 'harniverse.observe' }) status(): RemoteRuntimeStatus

/** Unlock the encrypted credential provider for this process.
 * @param key - canonical base64url encoding of 32 random bytes from the local authority.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async unlock(key: string): Promise<void>

/** Replace the complete encrypted credential map.
 * @param snapshot - complete credential map; omitted references are deleted.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async replaceCredentials(snapshot: Record<string, string>): Promise<void>

/** Replace the complete model and search settings snapshot.
 * @param snapshot - complete model/search user sections; omitted registered sections reset.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async syncSettings(snapshot: Record<string, JsonValue>): Promise<void>

/** Synchronous admission check for same-process consumers; never waits for a connection. */
assertUnlocked(): void
```

Source: [`packages/ssh/remote-runtime/src/index.ts:31`](../../packages/ssh/remote-runtime/src/index.ts)

<a id="ctxssh--sshconnection"></a>

### `ctx.ssh` — `SshConnection`

Loss invalidates this connection. A new connection captures a new remote revision.

```ts cordis-catalog
/**
 * Issue one bounded RPC against the connected helper.
 * @param method - the protocol method name.
 * @param params - its validated payload.
 * @param result - the schema every successful reply body must satisfy.
 * @param signal - cancellation for this request alone.
 * @param wait - true to use the connection lifetime instead of the administrative request timeout.
 * @returns the parsed reply body.
 */
async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>

/**
 * This description is pinned for the connection, including the captured Host Profile revision.
 * @returns the immutable world descriptor the helper verified at connect.
 */
async describeWorld(): Promise<WorldDescription>

/** Join helper cleanup when reachable, then close and join the owned OpenSSH process. */
dispose(): Promise<void>
```

Source: [`packages/ssh/ssh/src/index.ts:56`](../../packages/ssh/ssh/src/index.ts)
<!-- END GENERATED cordis-surface -->
