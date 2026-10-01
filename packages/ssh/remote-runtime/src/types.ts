/** Non-secret process status. Unlock state belongs to the encrypted provider. */
export interface RemoteRuntimeStatus {
  locked: boolean
  bootId: string
  platform: string
  arch: string
}

/** Discovery document consumed locally over SSH, never a credential carrier. */
export interface RuntimeEndpoint {
  version: 1
  host: '127.0.0.1'
  port: number
  protocol: 'http:' | 'https:'
  pid: number
  bootId: string
}
