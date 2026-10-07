/** Client-level mux wiring: URL, Bearer header, identity learning, and effect-scoped lifetime. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { internals } from '../src/internals.ts'
import { FakeHost } from './fixtures/socket.ts'
import { bootClient, REMOTE_HOST, restoreInternals } from './helpers.ts'

let booted: Context | undefined

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  vi.useRealTimers()
  restoreInternals()
  await booted?.fiber.dispose()
  booted = undefined
})

describe('HarniverseClient.openMux', () => {
  it('opens events.mux over ws with the Bearer header and learns the stream identity', async () => {
    const { ctx, client, carrier } = await bootClient()
    booted = ctx
    const sockets = new FakeHost()
    internals.createSocket = sockets.createSocket
    // No host.describe answer: the stream identity alone must supply expectedPrincipal.
    carrier.ok('POST /api/session.cancel', { accepted: true })
    const mux = client.openMux({ onFrame: () => undefined, cursors: { s1: 3 } })
    await vi.advanceTimersByTimeAsync(0)
    const socket = sockets.sockets[0]!
    expect(socket.url.protocol).toBe('ws:')
    expect(socket.url.pathname).toBe('/api/events.mux')
    expect(JSON.parse(socket.url.searchParams.get('since')!)).toEqual({ s1: 3 })
    expect(socket.headers.authorization).toBe('Bearer token-1')
    const revised = { kind: 'grant', grantId: 'grant-1', grantRevision: 5 }
    socket.open()
    socket.identity(revised)
    await vi.advanceTimersByTimeAsync(0)
    await mux.whenOpen()
    await client.call('session.cancel', { sessionId: 's1' })
    expect(carrier.to('/api/session.cancel')[0]?.body).toMatchObject({ expectedPrincipal: revised })
  })

  it('upgrades to wss for an HTTPS origin and keeps the remote host query', async () => {
    const { ctx, client } = await bootClient({ config: { origin: 'https://harniverse.example' } })
    booted = ctx
    const sockets = new FakeHost()
    internals.createSocket = sockets.createSocket
    client.openMux({ onFrame: () => undefined, remoteHost: REMOTE_HOST })
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets.sockets[0]?.url.href.startsWith('wss://harniverse.example/api/events.mux?')).toBe(true)
    expect(sockets.sockets[0]?.url.searchParams.get('dshRemoteHost')).toBe(REMOTE_HOST)
  })

  it('closes the mux when the owning scope is disposed', async () => {
    const { ctx, client } = await bootClient()
    booted = ctx
    const sockets = new FakeHost()
    internals.createSocket = sockets.createSocket
    client.openMux({ onFrame: () => undefined })
    await vi.advanceTimersByTimeAsync(0)
    sockets.sockets[0]!.open()
    await vi.advanceTimersByTimeAsync(0)
    await ctx.fiber.dispose()
    booted = undefined
    expect(sockets.sockets[0]?.closeCodes).toEqual([1000])
  })

  it('warns through the client logger', async () => {
    const { ctx, client } = await bootClient()
    booted = ctx
    const messages: string[] = []
    const original = client['ctx'].logger.warn.bind(client['ctx'].logger)
    client['ctx'].logger.warn = ((message: unknown) => { messages.push(String(message));  original(message) }) as typeof original
    client.warn('plain')
    client.warn('with cause', new Error('boom'))
    client.warn('with non-error', 'text')
    expect(messages).toEqual(['plain', 'with cause: boom', 'with non-error: text'])
  })
})
