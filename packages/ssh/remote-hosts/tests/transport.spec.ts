import { createServer } from 'node:http'
import { createPublicKey, verify } from 'node:crypto'
import { once } from 'node:events'
import { expect, it } from 'vitest'
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
      } else {
        expect(req.headers.cookie).toBeUndefined()
        expect(req.headers.origin).toBeUndefined()
        expect(req.headers.authorization).toMatch(/^Bearer token-/)
        res.end('{}')
      }
    })().catch((error: unknown) => { errors.push(error); res.statusCode = 500; res.end('{}') })
  })
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
    await expect(transport.request('https://evil.example/api/example')).rejects.toThrow('INVALID_PROXY_PATH')
    await expect(transport.request('/api/remoteHosts/list')).rejects.toThrow('INVALID_PROXY_PATH')
    await expect(transport.request('/api/../auth/token')).rejects.toThrow('INVALID_PROXY_PATH')
    await expect(transport.request('/api/%72emoteHosts/list')).rejects.toThrow('INVALID_PROXY_PATH')
    expect(errors).toEqual([])
  } finally {
    controller.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})
