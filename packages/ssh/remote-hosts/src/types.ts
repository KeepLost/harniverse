import type { Branded } from '@deepseek-ai/dsh-brand'
/** Stable local registry identity, independent of host name or address. */
export type RemoteHostId = Branded<'RemoteHostId'>
/** Supported operating-system labels for a deployed remote artifact. */
export type RemotePlatform = 'linux' | 'darwin' | 'win32'
/** Supported CPU architecture labels for a deployed remote artifact. */
export type RemoteArchitecture = 'x64' | 'arm64'

/** References only; private key values are never host configuration. */
export type HostAuthentication =
  | { kind: 'password'; passwordRef?: string }
  | { kind: 'key'; privateKeyRef?: string; passphraseRef?: string }
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
/** One-shot or persisted login secret supplied by an authorized caller. */
export type AuthSecrets =
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKey: string; passphrase?: string }

/** The key-file picking interaction this composition serves to clients. */
export type KeyFilePicker =
  /** The host can open its OS chooser; clients drive `pickKeyFile`. */
  | { kind: 'native' }
  /** No host-side chooser exists (browse or absent); the client reads the file itself. */
  | { kind: 'client' }

/** An operator-picked local key file: content feeds the form, path only labels it. */
export interface PickKeyFileResult {
  /** Absolute path of the picked file; absent when the operator cancelled. */
  path?: string
  /** UTF-8 file content for {@link AuthSecrets} `privateKey`; absent on cancel. */
  content?: string
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
/** Secret-free host record plus current local connection state. */
export interface RemoteHostView extends HostRecord {
  state: RemoteHostState
  /** Fixed diagnostic, never upstream stderr, command, token, or credential data. */
  error?: string
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
   * @returns the picked file's path and content, or neither when cancelled.
   */
  pickKeyFile(): Promise<PickKeyFileResult>
  /**
   * Report which key-file picking interaction this composition serves.
   * @returns `native` when the host opens its OS chooser, `client` otherwise.
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
}
