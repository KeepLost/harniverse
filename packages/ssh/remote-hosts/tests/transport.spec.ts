import { createServer } from 'node:http'
import { createPublicKey, verify } from 'node:crypto'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { identity } from '../src/secrets.ts'
import { HostTransport } from '../src/transport.ts'
import { remoteHostId } from '../src/validation.ts'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

it('coalesces token renewal, signs P1363 locally, strips incoming browser authority, and denies cross-origin paths', async () => {
  const stored = new Map<string, string>()
  const provider = { resolve: async (ref: string) => stored.has(ref) ? { value: stored.get(ref) } : undefined,
    set: async (ref: string, value: string) => { stored.set(ref, value) } } as unknown as CredentialProvider
  const id = remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50')
  const keys = await identity(provider, id)
  const key = createPublicKey({ key: Buffer.from(keys.publicKey, 'base64url'), type: 'spki', format: 'der' })
  let challenges = 0
  let tokens = 0
  const errors: unknown[] = []
  let holdWebSocketOpen = false
  const server = createServer((req, res) => {
    void (async () => {
      let text = ''; for await (const chunk of req) text += String(chunk)
      res.setHeader('content-type', 'application/json')
      if (req.url === '/auth/challenge') {
        challenges++
        res.end(JSON.stringify({ id: 'challenge', payload: 'signed payload', expiresAt: '2099-01-01T00:00:00.000Z' }))
      } else if (req.url === '/auth/token') {
        const body = JSON.parse(text) as { signature: string }
        expect(verify('sha256', Buffer.from('signed payload'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(body.signature, 'base64url'))).toBe(true)
        tokens++
        res.end(JSON.stringify({ accessToken: `token-${tokens}`, expiresAt: new Date(Date.now() + (tokens === 1 ? 1000 : 600000)).toISOString() }))
      } else if (req.url === '/api/identity') {
        res.end(JSON.stringify({ authentication: { kind: 'password' } }))
      } else if (req.url === '/api/remoteRuntime/success') {
        const body = JSON.parse(text) as { rpcId: string }
        res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { ready: true } } }))
      } else if (req.url === '/api/remoteRuntime/rejected') {
        const body = JSON.parse(text) as { rpcId: string }
        res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false } }))
      } else if (req.url === '/api/remoteRuntime/http-error') {
        res.statusCode = 503
        res.end('{}')
      } else if (req.url === '/api/plain') {
        res.setHeader('content-type', 'text/plain')
        res.end('plain')
      } else if (req.url === '/api/bad-json') {
        res.end('{broken')
      } else {
        expect(req.headers.cookie).toBeUndefined()
        expect(req.headers.origin).toBeUndefined()
        expect(req.headers.authorization).toMatch(/^Bearer token-/)
        res.end('{}')
      }
    })().catch((error: unknown) => { errors.push(error); res.statusCode = 500; res.end('{}') })
  })
  const websocketServer = new WebSocketServer({ server, path: '/api/events' })
  websocketServer.on('connection', (socket) => { if (!holdWebSocketOpen) socket.close() })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address')
  const controller = new AbortController()
  const transport = new HostTransport(address.port, 'grant', provider, id, controller.signal, 5000)
  try {
    await Promise.all(Array.from({ length: 12 }, async () => {
      const response = await transport.request('/api/example', { headers: { cookie: 'local-secret', authorization: 'local-token', origin: 'https://browser' } })
      await response.text()
    }))
    expect(tokens).toBe(1)
    await Promise.all(Array.from({ length: 12 }, async () => {
      await (await transport.request('/api/example')).text()
    }))
    expect(tokens).toBe(2)
    expect(challenges).toBe(2)
    await expect(transport.request('/api/bad-json')).resolves.toBeInstanceOf(Response)
    await expect(transport.request('/api/plain')).resolves.toBeInstanceOf(Response)
    await expect(transport.request('/api/identity')).resolves.toBeInstanceOf(Response)
    expect(transport.authentication()).toEqual({ kind: 'password' })
    await expect(transport.rpc('success', {})).resolves.toEqual({ ready: true })
    await expect(transport.rpc('rejected', {})).rejects.toThrow('REMOTE_RPC_REJECTED')
    await expect(transport.rpc('http-error', {})).rejects.toThrow('REMOTE_HTTP_REJECTED')
    const socket = await transport.openWebSocket('/api/events')
    await once(socket, 'close')
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(transport.openWebSocket('/api/events', aborted.signal)).rejects.toThrow('cancelled')
    const abortedWithoutError = new AbortController()
    abortedWithoutError.abort('cancelled')
    await expect(transport.openWebSocket('/api/events', abortedWithoutError.signal)).rejects.toThrow('ABORTED')
    holdWebSocketOpen = true
    const lifetime = new AbortController()
    const heldSocket = await transport.openWebSocket('/api/events', lifetime.signal)
    const heldClosed = once(heldSocket, 'close')
    lifetime.abort()
    await heldClosed
    holdWebSocketOpen = false
    await expect(transport.openWebSocket('/api/no-websocket')).rejects.toThrow()
    await expect(transport.openWebSocket('/api/../events')).rejects.toThrow('INVALID_PROXY_PATH')
    await expect(transport.request('https://evil.example/api/example')).rejects.toThrow('INVALID_PROXY_PATH')
    await expect(transport.request('/api/remoteHosts/list')).rejects.toThrow('INVALID_PROXY_PATH')
    await expect(transport.request('/api/../auth/token')).rejects.toThrow('INVALID_PROXY_PATH')
    await expect(transport.request('/api/%72emoteHosts/list')).rejects.toThrow('INVALID_PROXY_PATH')
    expect(errors).toEqual([])
  } finally {
    controller.abort()
    server.closeAllConnections()
    websocketServer.close()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})
