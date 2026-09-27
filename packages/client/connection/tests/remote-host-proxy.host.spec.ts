import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  authenticationGrantId,
  type AuthenticationPrincipal,
} from '@deepseek-ai/dsh-authentication'
import type { HostConnectionService } from '../src/rpc-host.ts'
import { registerRemoteHostProxy } from '../src/remote-host-proxy.ts'
import type { ConnectionHttpProxyHandler, ConnectionHttpProxyResolver } from '../src/rpc.ts'

const REMOTE_HOST = '22222222-2222-4222-8222-222222222222'

const PRINCIPAL: AuthenticationPrincipal = {
  kind: 'grant',
  grantId: authenticationGrantId('local-grant'),
  grantRevision: 4,
  capabilities: ALL_AUTHENTICATION_CAPABILITIES,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

interface RegisteredProxy {
  resolver: ConnectionHttpProxyResolver
  handler: ConnectionHttpProxyHandler
}

interface Provider {
  request(id: string, path: string, init?: RequestInit): Promise<Response>
  authentication(): unknown
}

interface CapturedRequest {
  id: string
  path: string
  init: RequestInit | undefined
}

function mounted(provider: Provider, requiredCapability = 'harniverse.observe'): RegisteredProxy {
  let registered: RegisteredProxy | undefined
  const services: Record<string, unknown> = {
    remoteHosts: provider,
    typert: { local: { get: (endpoint: string) => endpoint === 'sessions/list' ? { requiredCapability } : undefined } },
  }
  const context = {
    inject(_dependencies: readonly string[], callback: (ctx: { get(name: string): unknown }) => void): void {
      callback({ get: name => services[name] })
    },
  }
  const connection = {
    registerHttpProxy(_owner: Context, resolver: ConnectionHttpProxyResolver, handler: ConnectionHttpProxyHandler): () => Promise<void> {
      registered = { resolver, handler }
      return async () => {}
    },
  }
  registerRemoteHostProxy(context as unknown as Context, connection as unknown as HostConnectionService)
  if (registered === undefined) throw new Error('remote host proxy was not registered')
  return registered
}

describe('remote host HTTP proxy', () => {
  it('keeps management endpoints local and denies unknown targeted endpoints', () => {
    const proxy = mounted({ request: async () => new Response(), authentication: () => undefined })
    const targeted = new Request(`http://local/api/sessions/list?dshRemoteHost=${REMOTE_HOST}`)
    const localManagement = new Request(`http://local/api/remoteHosts/list?dshRemoteHost=${REMOTE_HOST}`)
    const noTarget = new Request('http://local/api/sessions/list')

    expect(proxy.resolver('sessions/list', targeted)).toEqual({ requiredCapability: 'harniverse.observe' })
    expect(proxy.resolver('remoteHosts/list', localManagement)).toBeUndefined()
    expect(proxy.resolver('sessions/list', noTarget)).toBeUndefined()
    expect(proxy.resolver('unknown/endpoint', targeted)).toEqual({ denied: true })
  })

  it('strips local transport headers, rewrites expectedPrincipal, and localizes the response identity', async () => {
    let captured: CapturedRequest | undefined
    const remoteIdentity = { kind: 'grant', grantId: 'remote-grant', grantRevision: 9 }
    const proxy = mounted({
      authentication: () => remoteIdentity,
      request: async (id, path, init) => {
        captured = { id, path, init }
        return Response.json({
          type: 'server-response',
          rpcId: 'remote-rpc',
          result: { ok: true, value: { accepted: true } },
          authentication: remoteIdentity,
        }, { headers: { 'content-type': 'application/json', 'content-length': '999', 'x-dsh-authentication': 'remote-secret' } })
      },
    })
    const request = new Request(`http://local/api/sessions/list?dshRemoteHost=${REMOTE_HOST}`, {
      method: 'POST',
      headers: {
        'accept-encoding': 'gzip',
        authorization: 'Bearer local-secret',
        cookie: 'session=local-secret',
        'content-type': 'application/json',
        host: 'local',
        origin: 'https://local.example',
        referer: 'https://local.example/app',
      },
      body: JSON.stringify({ type: 'client-request', expectedPrincipal: { kind: 'grant', grantId: 'wrong' } }),
    })

    const response = await proxy.handler(request, PRINCIPAL)
    const body = await response.json() as { authentication: unknown; result: unknown }

    expect(captured?.id).toBe(REMOTE_HOST)
    expect(captured?.path).toBe('/api/sessions/list')
    expect(captured?.init?.method).toBe('POST')
    expect(captured?.init?.headers).toEqual(new Headers({ 'content-type': 'application/json' }))
    expect(captured?.init?.body).toBe(JSON.stringify({
      type: 'client-request',
      expectedPrincipal: remoteIdentity,
    }))
    expect(body.result).toEqual({ ok: true, value: { accepted: true } })
    expect(body.authentication).toEqual({ kind: 'grant', grantId: 'local-grant', grantRevision: 4 })
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('x-dsh-authentication')).toBeNull()
  })

  it('maps a remote carrier failure to a gateway error', async () => {
    const proxy = mounted({
      authentication: () => undefined,
      request: async () => { throw new Error('remote unavailable') },
    })

    const response = await proxy.handler(
      new Request(`http://local/api/sessions/list?dshRemoteHost=${REMOTE_HOST}`),
      PRINCIPAL,
    )

    expect(response.status).toBe(502)
    await expect(response.text()).resolves.toBe('remote host request failed')
  })
})
