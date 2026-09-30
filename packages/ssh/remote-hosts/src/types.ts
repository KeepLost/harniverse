import type { Branded } from '@deepseek-ai/dsh-brand'
/** Stable local registry identity, independent of host name or address. */
export type RemoteHostId = Branded<'RemoteHostId'>
/** Supported operating-system labels for a deployed remote artifact. */
export type RemotePlatform = 'linux' | 'darwin' | 'win32'
/** Supported CPU architecture labels for a deployed remote artifact. */
export type RemoteArchitecture = 'x64' | 'arm64'

/**
 * Persisted login material references or a host-local key path; private key
 * values are never host configuration.
 */
export type HostAuthentication =
  | { kind: 'password'; passwordRef?: string }
  | { kind: 'key'; privateKeyRef?: string; keyPath?: string; passphraseRef?: string }
  | { kind: 'agent'; socket: string }

/** Exact per-host authorization for one remote loopback reverse listener. */
export interface ReverseMapping {
  localHost: string
  localPort: number
  remoteOriginalOrigin: string
}
/** Reverse mapping with the allocated remote loopback port. */
export interface ActiveReverseMapping extends ReverseMapping { remotePort: number }

/** Persisted host configuration contains no credential values. */
export interface HostConfig {
  name: string
  host: string
  port: number
  username: string
  fingerprint: string
  platform: RemotePlatform
  architecture: RemoteArchitecture
  dshHome?: string
  authentication: HostAuthentication
  reverseMappings: ReverseMapping[]
}
/** Persisted host record with its stable local identity. */
export interface HostRecord extends HostConfig { id: RemoteHostId }
/**
 * One-shot or persisted login secret supplied by an authorized caller. A key
 * login carries exactly one of inline material or a host-local file path; the
 * path is read on this host at use time.
 */
export type AuthSecrets =
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKey: string; privateKeyPath?: undefined; passphrase?: string }
  | { kind: 'key'; privateKey?: undefined; privateKeyPath: string; passphrase?: string }

/**
 * The key-file picking interaction this composition serves. `native` needs the
 * operator at the host's own display; `browse` serves every deployment.
 */
export type KeyFilePicker =
  /** The host can open its OS chooser; clients drive `pickKeyFile`. */
  | { kind: 'native' }
  /** Clients browse host directories one level at a time through `listKeyFiles` and pick a file. */
  | { kind: 'browse' }

/** An operator-picked host-local key file path; absent when the operator cancelled. */
export interface PickKeyFileResult {
  /** Absolute path of the picked file on this host. */
  path?: string
}

/** One directory level to list for the browse key-file interaction. */
export interface ListKeyFilesInput {
  /** Absolute host directory; absent lists the operator's `~/.ssh`, else the home directory. */
  path?: string
}

/** One row of a key-file listing: a directory to enter or a file to pick. */
export interface KeyFileEntry {
  /** Base name within the listed directory. */
  name: string
  /** Absolute host path of the entry. */
  path: string
  /** What the entry is after following symbolic links. */
  kind: 'directory' | 'file'
}

/** One host directory level as the key-file browser shows it. */
export interface KeyFileListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The directory above it; absent at a filesystem root. */
  parent?: string
  /** Directories first, then files, each name-sorted. */
  entries: KeyFileEntry[]
  /** True when the level holds more entries than the listing bound admits. */
  truncated: boolean
}

/** Full replacement. Omitted port and mappings default to 22 and []. */
export interface UpsertHostInput extends Omit<HostConfig, 'port' | 'reverseMappings'> {
  id?: RemoteHostId
  port?: number
  reverseMappings?: ReverseMapping[]
  secrets?: AuthSecrets
  /** Only true authorizes saving submitted secrets through ctx.credentials. */
  storeCredentials?: boolean
}
/** Input for connecting one configured host. */
export interface ConnectHostInput {
  id: RemoteHostId
  secrets?: AuthSecrets
  storeCredentials?: boolean
}
/** Lifecycle state of one local remote-host session. */
export type RemoteHostState = 'offline' | 'connecting' | 'deploying' | 'connected' | 'error'
/** The operation currently keeping a remote host in the deploying state. */
export type RemoteHostProgressPhase = 'checking-artifact' | 'uploading' | 'verifying' | 'authorizing'
  | 'starting' | 'forwarding' | 'synchronizing'
/** Bounded progress for one deployment step; values never contain command or secret data. */
export interface RemoteHostProgress {
  phase: RemoteHostProgressPhase
  current: number
  total: number
}
/** Secret-free host record plus current local connection state. */
export interface RemoteHostView extends HostRecord {
  state: RemoteHostState
  /** Fixed diagnostic, never upstream stderr, command, token, or credential data. */
  error?: string
  /** Current deployment step, present only while the host is deploying. */
  progress?: RemoteHostProgress
}
/** SSH target plus explicit credentials used for a connectivity test. */
export interface VerifyHostInput { host: string; port?: number; username: string; secrets: AuthSecrets }
/** Evidence one successful connectivity test established about a reachable target. */
export interface ConnectivityResult {
  /** Host-key fingerprint the tested connection authenticated under. */
  fingerprint: string
  /** Remote operating system reported by that connection. */
  platform: RemotePlatform
  /** Remote CPU architecture reported by that connection. */
  architecture: RemoteArchitecture
}
/** Runtime configuration for local remote-host coordination. */
export interface Config {
  /** Local registry directory; defaults to standard DSH_HOME resolution. */
  dshHome?: string
  /** Absolute local root containing linux-x64/, darwin-arm64/, win32-x64/, etc. */
  artifactsRoot: string
  /** Maximum time allowed for startup and remote endpoint discovery. */
  startupTimeoutMs?: number
  /** Maximum time allowed for one proxied remote operation. */
  requestTimeoutMs?: number
  /** Keepalive period for the remote runtime's owner lease (default 10s; below the 45s exit window). */
  heartbeatIntervalMs?: number
}

/** Definition consumed by management UIs and trusted same-process proxy plugins. */
export interface RemoteHostsProvider {
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
    * @returns `native` when the host can open its own chooser, else `browse` for the in-app listing.
    */
  keyFilePicker(): Promise<KeyFilePicker>
  /**
   * List one host directory level, directories and files alike, for the
   * `browse` key-file interaction. Serves the `browse` interaction only.
   * @param input - absolute directory; absent starts at the operator's `~/.ssh`.
   * @returns the bounded listing of that level.
   */
  listKeyFiles(input: ListKeyFilesInput): Promise<KeyFileListing>
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
}
