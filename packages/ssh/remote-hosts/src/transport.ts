import { randomUUID, sign } from 'node:crypto'
import { GrantAccess } from '@deepseek-ai/dsh-sdk-client'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import WebSocket from 'ws'
import { z } from 'zod'
import type { RemoteHostId } from './types.ts'
import { signingKey } from './secrets.ts'
import { RemoteHostsError } from './validation.ts'

export const endpointSchema = z.strictObject({ version: z.literal(1), host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65535), protocol: z.enum(['http:', 'https:']), pid: z.number().int().positive(), bootId: z.uuid() })
export type Endpoint = z.infer<typeof endpointSchema>
export const statusSchema = z.strictObject({ locked: z.boolean(), bootId: z.uuid(), platform: z.string(), arch: z.string() })

export class HostTransport {
  private readonly access: GrantAccess
  private readonly origin: string
  private remoteIdentity: unknown
  constructor(port: number, grantId: string, provider: CredentialProvider, id: RemoteHostId, signal: AbortSignal, timeout: number) {
    this.origin = `http://127.0.0.1:${port}`
    this.access = new GrantAccess({ origin: this.origin, grantId,
      signChallenge: async payload => sign('sha256', Buffer.from(payload), { key: await signingKey(provider, id), dsaEncoding: 'ieee-p1363' }).toString('base64url'),
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout), ...(init?.signal ? [init.signal] : [])]) }),
    })
    signal.addEventListener('abort', () => { this.access.clear() }, { once: true })
  }
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.checkedUrl(path)
    const headers = new Headers(init.headers)
    for (const name of ['authorization', 'cookie', 'host', 'origin', 'referer']) headers.delete(name)
    const response = await this.access.fetch(url, { ...init, headers, redirect: 'error' })
    await this.captureAuthentication(response)
    return response
  }

  /** Stable identity returned by the remote carrier, when one has settled. */
  authentication(): unknown { return this.remoteIdentity }

  /** Open one authenticated remote WebSocket through the SSH local forward. */
  async openWebSocket(path: string, signal?: AbortSignal): Promise<WebSocket> {
    const url = this.checkedUrl(path)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const authorization = await this.access.authorization()
    const socket = new WebSocket(url, { headers: { authorization } })
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        socket.close()
        reject(signal?.reason instanceof Error ? signal.reason : new RemoteHostsError('ABORTED'))
      }
      const onOpen = (): void => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const onError = (error: Error): void => {
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
      socket.once('open', onOpen)
      socket.once('error', onError)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    signal?.addEventListener('abort', () => { socket.close() }, { once: true })
    return socket
  }

  private checkedUrl(path: string): URL {
    const url = new URL(path, this.origin)
    const decoded = decodeURIComponent(url.pathname)
    if (!path.startsWith('/api/') || !url.pathname.startsWith('/api/') || url.origin !== this.origin
      || url.username || url.password || url.hash || decoded.split('/')[2] === 'remoteHosts'
      || decoded.split('/').some(part => part === '.' || part === '..') || decoded.includes('\\')) {
      throw new RemoteHostsError('INVALID_PROXY_PATH')
    }
    return url
  }

  private async captureAuthentication(response: Response): Promise<void> {
    if (this.remoteIdentity !== undefined) return
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return
    try {
      const body = await response.clone().json() as { authentication?: unknown }
      if (body.authentication !== undefined) this.remoteIdentity = body.authentication
    } catch {
      // A streaming or malformed response has no usable carrier identity.
    }
  }
  async rpc(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const rpcId = randomUUID()
    const response = await this.request(`/api/remoteRuntime/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      ...(signal === undefined ? {} : { signal }),
      body: JSON.stringify({ type: 'client-request', rpcId, method: `remoteRuntime/${method}`, payload: { args: payload } }) })
    if (!response.ok) throw new RemoteHostsError('REMOTE_HTTP_REJECTED')
    const body = z.object({ type: z.literal('server-response'), rpcId: z.literal(rpcId), result: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), value: z.unknown().optional() }), z.object({ ok: z.literal(false) }),
    ]) }).parse(await response.json())
    if (!body.result.ok) throw new RemoteHostsError('REMOTE_RPC_REJECTED')
    return body.result.value
  }
}
