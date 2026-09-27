/** Consumer contracts for the replaceable remote-host SSH provider. */
export interface RemoteHostSshTarget {
  host: string
  /** SSH port; defaults to 22. */
  port?: number
  username: string
}

/** Each connection requires an independently approved OpenSSH SHA256 pin. */
export interface RemoteHostSshConfig extends RemoteHostSshTarget {
  fingerprint: string
}

/** Credentials are explicit; no ambient SSH config or agent is consulted. */
export type RemoteHostSshAuthentication =
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKey: string; passphrase?: string }
  | { kind: 'agent'; socket: string }

/** Provider-wide bounds, validated when the plugin mounts. */
export interface Config {
  connectTimeoutMs?: number
  operationTimeoutMs?: number
  maxOutputBytes?: number
  maxReadBytes?: number
}

/** Exact bytes; absent SSH exit metadata is null, never a synthetic success. */
export interface RemoteHostSshExecResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number | null
  signal: string | null
}

/** A connection-owned listener; close also drains its accepted sockets. */
export interface RemoteHostSshForward {
  readonly port: number
  /** Remove this listener and await its sockets' closure. */
  close(): Promise<void>
}

/** Only this explicit destination is reachable through the remote loopback listener. */
export interface RemoteHostSshReverseConfig {
  /** Zero or omitted requests an ephemeral remote port. */
  remotePort?: number
  localHost: string
  localPort: number
}

/** Transport ownership belongs to the caller and the mounting plugin. */
export interface RemoteHostSshConnection {
  /** Resolves after transport, owned channels, local listeners and uploads stop. */
  readonly closed: Promise<void>
  /** Aborted on disconnect, cancellation, timeout, or disposal. */
  readonly signal: AbortSignal
  /** Run a caller-authored command. Cancellation or overflow closes this connection. */
  exec(command: string, input?: string | Buffer, signal?: AbortSignal): Promise<RemoteHostSshExecResult>
  /** Upload to a caller-owned private directory; create/overwrite with mode 0600. */
  upload(localPath: string, remotePath: string, signal?: AbortSignal): Promise<void>
  /** Read at most maxReadBytes; reject larger files without returning partial data. */
  readFile(path: string, signal?: AbortSignal): Promise<Buffer>
  /** Resolve a server-native path without local path normalization. */
  realpath(path: string, signal?: AbortSignal): Promise<string>
  /** Create one directory with mode 0700; existing paths remain errors. */
  mkdir(path: string, signal?: AbortSignal): Promise<void>
  /** Listen on local 127.0.0.1 and connect accepted sockets to this remote target. */
  forward(remoteHost: string, remotePort: number, signal?: AbortSignal): Promise<RemoteHostSshForward>
  /** Bind remote 127.0.0.1 and authorize exactly this connection's mapping. */
  reverse(config: RemoteHostSshReverseConfig, signal?: AbortSignal): Promise<RemoteHostSshForward>
  /** Close transport resources; no remote agent lifecycle command or signal is sent. */
  dispose(): Promise<void>
}

/** Consumer contract implemented by the Cordis service or a replacement provider. */
export interface RemoteHostSshProvider {
  /** Verify the pin before authentication and return an owned connection. */
  open(config: RemoteHostSshConfig, authentication: RemoteHostSshAuthentication, signal?: AbortSignal): Promise<RemoteHostSshConnection>
  /** Observe an untrusted fingerprint, reject its key, and close before authentication. */
  probe(config: RemoteHostSshTarget, signal?: AbortSignal): Promise<string>
}

/** Stable, secret-free transport failure categories. */
export type RemoteHostSshErrorCode =
  | 'INVALID_CONFIG' | 'INVALID_ARGUMENT' | 'HOST_KEY_MISMATCH'
  | 'CONNECT_FAILED' | 'OPERATION_FAILED' | 'CLOSED' | 'ABORTED' | 'TIMED_OUT' | 'LIMIT_EXCEEDED'
