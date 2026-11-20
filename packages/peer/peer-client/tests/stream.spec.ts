/** Event-stream client: subscribe calls, stream reading, frame parsing, and transport fault classification. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensureInstanceIdentity } from '@deepseek-ai/dsh-peer-protocol'
import { ensurePeerIdentityKey } from '../src/keys.ts'
import {
  callPeerRemote,
  openPeerEventStream,
  parsePeerEventFrame,
  runPeerCancel,
  runPeerSubscribe,
} from '../src/remote.ts'
import type { PeerCallIdentity, PeerStreamOptions } from '../src/remote.ts'
import type { PeerTarget } from '@deepseek-ai/dsh-peer-protocol'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'peer-stream-'))
  directories.push(path)
  return path
}

const target: PeerTarget = {
  targetInstanceId: '3f2a8f9e-1111-4222-8333-444455556666',
  displayName: 'Build workstation',
  endpoint: { origin: 'http://127.0.0.1:42001' },
  transport: { kind: 'direct' },
  grantName: 'peer-3f2a8f9e-1111-4222-8333-444455556666',
  grantId: 'grant-1',
  status: 'active',
  addedAt: '2026-01-01T00:00:00.000Z',
}

/** Resolve one home's call identity: instance anchor plus signing key. */
async function identityOf(homePath: string): Promise<PeerCallIdentity> {
  const identity = await ensureInstanceIdentity(homePath)
  return { instanceId: identity.instanceId, key: await ensurePeerIdentityKey(homePath) }
}

/** The approved token-exchange prefix every first authenticated call consumes. */
const exchange = [
  { body: { id: 'cha', payload: 'c2lnbg', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
  { body: { accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
]

/** Build one scripted fetch answering queued JSON replies in order. */
function scripted(responses: Array<{ status?: number; body?: unknown }>): typeof globalThis.fetch {
  let index = 0
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const reply = responses[Math.min(index, responses.length - 1)]!
    index += 1
    if (reply.status !== undefined && reply.status !== 200) return new Response('', { status: reply.status })
    let body = reply.body === undefined ? {} : reply.body
    const request = init?.body === undefined ? {} : JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { rpcId?: string }
    if (typeof request.rpcId === 'string' && typeof body === 'object' && body !== null) {
      body = { ...body as Record<string, unknown>, rpcId: request.rpcId }
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

it('parses settlement frames and rejects malformed payloads', () => {
  expect(parsePeerEventFrame('{"kind":"settled","sessionId":"peer-1"}')).toEqual({ kind: 'settled', sessionId: 'peer-1' })
  expect(() => { parsePeerEventFrame('not json') }).toThrowError(/malformed event frame/)
  expect(() => { parsePeerEventFrame('"text"') }).toThrowError(/malformed event frame/)
  expect(() => { parsePeerEventFrame('{"kind":"other","sessionId":"peer-1"}') }).toThrowError(/malformed event frame/)
  expect(() => { parsePeerEventFrame('{"kind":"settled","sessionId":""}') }).toThrowError(/malformed event frame/)
  expect(() => { parsePeerEventFrame('{"kind":"settled","sessionId":"x'.repeat(81) + '"}') }).toThrowError(/malformed event frame/)
})

it('subscribes through the RPC envelope and validates the readback', async () => {
  const root = await home()
  const identity = await identityOf(root)
  const options = { target, home: root, origin: 'http://127.0.0.1:42001', timeoutMs: 250 }
  const envelope = (value: unknown): unknown => ({ type: 'server-response', result: { ok: true, value } })
  const granted = await runPeerSubscribe({ ...options, fetch: scripted([...exchange, { body: envelope({ streamToken: 'st-1', heartbeatMs: 15_000 }) }]) }, identity)
  expect(granted).toEqual({ streamToken: 'st-1', heartbeatMs: 15_000 })
  await expect(runPeerSubscribe({ ...options, fetch: scripted([...exchange, { body: envelope({ streamToken: '' }) }]) }, identity))
    .rejects.toThrowError(/malformed subscribe result/)
  await expect(runPeerSubscribe({ ...options, fetch: scripted([...exchange, { body: envelope({ streamToken: 'st-1', heartbeatMs: 0 }) }]) }, identity))
    .rejects.toThrowError(/malformed subscribe result/)
  await expect(runPeerSubscribe({ ...options, fetch: scripted([...exchange, { body: envelope({ heartbeatMs: 15 }) }]) }, identity))
    .rejects.toThrowError(/malformed subscribe result/)
  await expect(runPeerSubscribe({ ...options, fetch: scripted([...exchange, { body: envelope('text') }]) }, identity))
    .rejects.toThrowError(/malformed subscribe result/)
  const untimed = { target, home: root, origin: 'http://127.0.0.1:42001', fetch: scripted([...exchange, { body: envelope({ streamToken: 'st-2', heartbeatMs: 15_000 }) }]) }
  expect(await runPeerSubscribe(untimed, identity)).toEqual({ streamToken: 'st-2', heartbeatMs: 15_000 })
})

it('cancels the current turn through the RPC envelope', async () => {
  const root = await home()
  const identity = await identityOf(root)
  const options = { target, home: root, origin: 'http://127.0.0.1:42001', timeoutMs: 250 }
  const envelope = (value: unknown): unknown => ({ type: 'server-response', result: { ok: true, value } })
  const result = await runPeerCancel({ ...options, fetch: scripted([...exchange, {
    body: envelope({ sessionId: 'peer-1', messageId: 'm1', state: 'settled', endReason: 'user' }),
  }]) }, identity, 'peer-1')
  expect(result).toEqual({ sessionId: 'peer-1', messageId: 'm1', state: 'settled', endReason: 'user' })
  await expect(runPeerCancel({ ...options, fetch: scripted([...exchange, { body: envelope({ state: 'nope' }) }]) }, identity, 'peer-1'))
    .rejects.toThrowError(/malformed run result/)
})

/** One SSE body delivering queued chunks, then ending. */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index]))
      index += 1
    },
  })
}

/** Stream options pinned to one fetch implementation. */
function streamOptions(fetch: typeof globalThis.fetch, signal: AbortSignal): PeerStreamOptions {
  return { target, home: 'unused', origin: 'http://127.0.0.1:42001', fetch, signal }
}

it('reads frames from the event stream, ignoring heartbeat comments', async () => {
  const frames: string[] = []
  const controller = new AbortController()
  const fetchImpl = (async () => new Response(sseBody([
    ': peer\n\n',
    'data: {"kind":"settled","sessionId":"peer-1"}\n\ndata: {"kind":"settled","sessionId":"peer-2"}\n\n',
    'data: {"kind":"settled","sessionId":"peer-3"}\n\n',
  ]), { status: 200 })) as typeof globalThis.fetch
  await openPeerEventStream(streamOptions(fetchImpl, controller.signal), 'st-1', (frame) => {
    frames.push(frame.sessionId)
  })
  expect(frames).toEqual(['peer-1', 'peer-2', 'peer-3'])
})

it('rejects refused streams and null bodies', async () => {
  const controller = new AbortController()
  const refused = (async () => new Response('no', { status: 403 })) as typeof globalThis.fetch
  await expect(openPeerEventStream(streamOptions(refused, controller.signal), 'st-1', () => {}))
    .rejects.toThrowError(/event stream HTTP 403/)
  const empty = (async () => new Response(null, { status: 200 })) as typeof globalThis.fetch
  await expect(openPeerEventStream(streamOptions(empty, controller.signal), 'st-1', () => {}))
    .rejects.toThrowError(/event stream HTTP 200/)
})

it('ends quietly on abort, before or during the stream', async () => {
  const aborted = new AbortController()
  aborted.abort()
  const failing = (async () => { throw new Error('connection refused') }) as typeof globalThis.fetch
  await expect(openPeerEventStream(streamOptions(failing, aborted.signal), 'st-1', () => {})).resolves.toBeUndefined()

  const during = new AbortController()
  let reads = 0
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      reads += 1
      if (reads === 1) return { done: false, value: new TextEncoder().encode('data: {"kind":"settled","sessionId":"peer-1"}\n\n') }
      during.abort()
      throw new Error('aborted mid-stream')
    },
    cancel: async (): Promise<void> => { throw new Error('already torn down') },
  }
  const body = { getReader: () => reader }
  const fetchImpl = (async () => ({ ok: true, status: 200, body })) as unknown as typeof globalThis.fetch
  const frames: string[] = []
  await expect(openPeerEventStream(streamOptions(fetchImpl, during.signal), 'st-1', (frame) => {
    frames.push(frame.sessionId)
  })).resolves.toBeUndefined()
  expect(frames).toEqual(['peer-1'])
})

it('wraps fetch throws from live streams', async () => {
  const controller = new AbortController()
  const erroring = (async () => { throw new Error('connection reset') }) as typeof globalThis.fetch
  await expect(openPeerEventStream(streamOptions(erroring, controller.signal), 'st-1', () => {}))
    .rejects.toThrowError(/TRANSPORT_FAILED \(connection reset\)/)
  const nonError = (async () => { throw 'raw failure' }) as unknown as typeof globalThis.fetch
  await expect(openPeerEventStream(streamOptions(nonError, controller.signal), 'st-1', () => {}))
    .rejects.toThrowError(/TRANSPORT_FAILED \(raw failure\)/)
})

it('surfaces malformed frames through the sink contract', async () => {
  const controller = new AbortController()
  const malformed = (async () => new Response(sseBody(['data: nope\n\n']), { status: 200 })) as typeof globalThis.fetch
  await expect(openPeerEventStream(streamOptions(malformed, controller.signal), 'st-1', () => {}))
    .rejects.toThrowError(/malformed event frame/)
})

it('classifies Grant rejections, transport faults, and hello faults on fetch throws', async () => {
  const revoked = { fetch: (async () => { throw new Error('GrantAccess: token exchange rejected (401)') }) as typeof globalThis.fetch }
  await expect(callPeerRemote(revoked as never, 'http://127.0.0.1:42001', 'result', {}))
    .rejects.toThrowError(/EXCHANGE_FAILED \(grant rejected; remove the stale target record and re-pair with a fresh invitation\)/)
  const refused = { fetch: (async () => { throw new TypeError('fetch failed') }) as typeof globalThis.fetch }
  await expect(callPeerRemote(refused as never, 'http://127.0.0.1:42001', 'result', {}))
    .rejects.toThrowError(/TRANSPORT_FAILED/)
  await expect(callPeerRemote(refused as never, 'http://127.0.0.1:42001', 'hello', {}))
    .rejects.toThrowError(/HELLO_REJECTED/)
  const nonError = { fetch: (() => { throw 'raw failure' }) as unknown as typeof globalThis.fetch }
  await expect(callPeerRemote(nonError as never, 'http://127.0.0.1:42001', 'result', {}))
    .rejects.toThrowError(/TRANSPORT_FAILED \(raw failure\)/)
})
