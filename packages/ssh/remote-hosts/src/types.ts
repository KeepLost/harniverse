import type { Branded } from '@deepseek-ai/dsh-brand'
/** Stable local registry identity, independent of host name or address. */
export type RemoteHostId = Branded<'RemoteHostId'>
export type RemotePlatform = 'linux' | 'darwin' | 'win32'
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
export interface HostRecord extends HostConfig { id: RemoteHostId }
export type AuthSecrets =
  | { kind: 'password'; password: string }
  | { kind: 'key'; privateKey: string; passphrase?: string }

/** Full replacement. Omitted port and mappings default to 22 and []. */
export interface UpsertHostInput extends Omit<HostConfig, 'port' | 'reverseMappings'> {
  id?: RemoteHostId
  port?: number
  reverseMappings?: ReverseMapping[]
  secrets?: AuthSecrets
  /** Only true authorizes saving submitted secrets through ctx.credentials. */
  storeCredentials?: boolean
}
export interface ConnectHostInput {
  id: RemoteHostId
  secrets?: AuthSecrets
  storeCredentials?: boolean
}
export type RemoteHostState = 'offline' | 'connecting' | 'deploying' | 'connected' | 'error'
export interface RemoteHostView extends HostRecord {
  state: RemoteHostState
  /** Fixed diagnostic, never upstream stderr, command, token, or credential data. */
  error?: string
}
export interface ProbeHostInput { host: string; port?: number; username: string }
export interface Config {
  /** Local registry directory; defaults to standard DSH_HOME resolution. */
  dshHome?: string
  /** Absolute local root containing linux-x64/, darwin-arm64/, win32-x64/, etc. */
  artifactsRoot: string
  startupTimeoutMs?: number
  requestTimeoutMs?: number
}

/** Definition consumed by management UIs and trusted same-process proxy plugins. */
export interface RemoteHostsProvider {
  list(): Promise<RemoteHostView[]>
  upsert(input: UpsertHostInput): Promise<RemoteHostView>
  remove(id: RemoteHostId): Promise<void>
  probe(input: ProbeHostInput): Promise<{ fingerprint: string }>
  connect(input: ConnectHostInput): Promise<RemoteHostView>
  disconnect(id: RemoteHostId): Promise<void>
  request(id: RemoteHostId, path: string, init?: RequestInit): Promise<Response>
  openWebSocket(id: RemoteHostId, path: string, signal?: AbortSignal): Promise<unknown>
  authentication(id: RemoteHostId): unknown
  reverseMappings(id: RemoteHostId): readonly ActiveReverseMapping[]
}
