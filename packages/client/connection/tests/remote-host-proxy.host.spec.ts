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
    expect(proxy.resolver('settings/list', new Request(`http://local/api/settings/list?dshRemoteHost=${REMOTE_HOST}`))).toBeUndefined()
    expect(proxy.resolver('credentials/list', new Request(`http://local/api/credentials/list?dshRemoteHost=${REMOTE_HOST}`))).toBeUndefined()
    expect(proxy.resolver('sessions/list', noTarget)).toBeUndefined()
    expect(proxy.resolver('unknown/endpoint', targeted)).toEqual({ denied: true })
    expect(proxy.resolver('sessions/list', new Request('http://local/api/sessions/list?dshRemoteHost=invalid'))).toBeUndefined()
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

  it('keeps malformed request and non-JSON response bodies opaque', async () => {
    const calls: CapturedRequest[] = []
    const proxy = mounted({
      authentication: () => ({ kind: 'grant', grantId: 'remote-grant' }),
      request: async (id, path, init) => {
        calls.push({ id, path, init })
        return new Response('not-json', { status: 502, headers: { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' } })
      },
    })
    const malformed = new Request(`http://local/api/sessions/list?dshRemoteHost=${REMOTE_HOST}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
    })
    const response = await proxy.handler(malformed, PRINCIPAL)
    expect(calls[0]?.init?.body).toBe('{broken')
    expect(response.status).toBe(502)
    expect(response.headers.get('www-authenticate')).toBeNull()
    await expect(response.text()).resolves.toBe('not-json')

    const local = await proxy.handler(new Request('http://local/api/sessions/list'), PRINCIPAL)
    expect(local.status).toBe(403)
    const invalid = await proxy.handler(new Request('http://local/api/sessions/list?dshRemoteHost=bad'), PRINCIPAL)
    expect(invalid.status).toBe(403)
    const absent = await proxy.handler(new Request('http://local/api/sessions/list'), PRINCIPAL)
    expect(absent.status).toBe(403)
  })

  it('leaves GET bodies absent and preserves malformed JSON carrier responses', async () => {
    let captured: CapturedRequest | undefined
    const proxy = mounted({
      authentication: () => undefined,
      request: async (_id, _path, init) => {
        captured = { id: REMOTE_HOST, path: '/api/sessions/list', init }
        return new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const response = await proxy.handler(
      new Request(`http://local/api/sessions/list?dshRemoteHost=${REMOTE_HOST}`), PRINCIPAL,
    )
    expect(captured?.init?.body).toBeUndefined()
    expect(await response.text()).toBe('{broken')

    const noPrincipalBody = new Request(`http://local/api/sessions/list?dshRemoteHost=${REMOTE_HOST}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'ordinary' }),
    })
    await proxy.handler(noPrincipalBody, PRINCIPAL)
    expect(captured?.init?.body).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(captured?.init?.body as ArrayBuffer)).toBe(JSON.stringify({ type: 'ordinary' }))

    const withPrincipal = mounted({
      authentication: () => ({ kind: 'grant', grantId: 'remote-grant' }),
      request: async (_id, _path, init) => {
        captured = { id: REMOTE_HOST, path: '/api/sessions/list', init }
        return new Response('plain', { headers: { 'content-type': 'text/plain' } })
      },
    })
    await withPrincipal.handler(new Request(`http://local/api/sessions/list?dshRemoteHost=${REMOTE_HOST}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'ordinary' }),
    }), PRINCIPAL)
    expect(captured?.init?.body).toBe(JSON.stringify({ type: 'ordinary' }))
  })
})
