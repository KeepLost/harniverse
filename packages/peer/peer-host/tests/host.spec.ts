import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PeerError, ensureInstanceIdentity, peerHelloMessage, peerInstanceId, peerRequestMessage } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerRecord } from '@deepseek-ai/dsh-peer-protocol'
import PeerHost from '../src/index.ts'
import { parsePeerRecord, peerStorePath, readPeerStore, writePeerStore } from '../src/store.ts'

const directories: string[] = []
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function mount(dshHome: string): Promise<Context> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(PeerHost, { dshHome })
  return ctx
}

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'peer-host-'))
  directories.push(path)
  return path
}

const initiator = {
  instanceId: peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666'),
  displayName: 'Laptop',
  platform: 'darwin',
  arch: 'arm64',
  version: '1.0.0-rc.3',
}

/** One throwaway P-256 signing identity for hello proofs. */
function identityKey(): { publicKey: string; sign(payload: string): string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    sign: payload => sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  }
}

/** Run one complete challenge/hello handshake against the mounted host.
 * @param host - the mounted peer host.
 * @param overrides - identity or key overrides for the proof under test.
 */
async function handshake(
  host: PeerHost,
  overrides: { identity?: Partial<typeof initiator>; key?: ReturnType<typeof identityKey>; challenge?: string } = {},
) {
  const key = overrides.key ?? identityKey()
  const challenge = overrides.challenge ?? (await host.challenge()).challenge
  const identity = { ...initiator, ...overrides.identity }
  return await host.hello({
    challenge,
    identity,
    proof: { publicKey: key.publicKey, signature: key.sign(peerHelloMessage(identity.instanceId, challenge)) },
  })
}

it('answers hello with this instance identity and commits the first pinned record', async () => {
  const root = await home()
  const self = await ensureInstanceIdentity(root)
  const ctx = await mount(root)
  const host = ctx.peerHost
  const key = identityKey()
  const paired: PeerRecord[] = []
  ctx.on('peer/paired', (record: PeerRecord) => { paired.push(record) })
  const hello = await handshake(host, { key })
  expect(hello.instanceId).toBe(self.instanceId)
  expect(hello.surface).toEqual({ delegate: true, message: true, list: true })
  const peers = await readPeerStore(root)
  expect(peers).toHaveLength(1)
  expect(peers[0]).toMatchObject({ instanceId: initiator.instanceId, displayName: 'Laptop', status: 'active', identityPublicKey: key.publicKey })
  expect(paired).toHaveLength(1)
})

it('refreshes an existing peer without re-emitting the paired event and keeps the pinned key authoritative', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  const { peerHost: host } = await mount(root)
  const key = identityKey()
  await handshake(host, { key })
  const before = (await readPeerStore(root))[0]!
  await new Promise(resolve => setTimeout(resolve, 5))
  await handshake(host, { key, identity: { displayName: 'Renamed' } })
  const after = (await readPeerStore(root))[0]!
  expect(after.displayName).toBe('Renamed')
  expect(after.firstSeenAt).toBe(before.firstSeenAt)
  expect(after.identityPublicKey).toBe(key.publicKey)
  expect(Date.parse(after.lastSeenAt)).toBeGreaterThan(Date.parse(before.lastSeenAt))
})

it('expires outstanding challenges and evicts the oldest past the pending bound', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  const { peerHost: host } = await mount(root)
  const first = (await host.challenge()).challenge
  vi.useFakeTimers()
  try {
    vi.setSystemTime(Date.now() + 6 * 60_000)
    for (let index = 0; index < 257; index += 1) await host.challenge()
  } finally {
    vi.useRealTimers()
  }
  await expect(handshake(host, { challenge: first })).rejects.toThrowError(/CHALLENGE_EXPIRED/)
  const { peerHost: fresh } = await mount(root)
  const expiryKey = identityKey()
  const minted = (await fresh.challenge()).challenge
  vi.useFakeTimers()
  try {
    vi.setSystemTime(Date.now() + 6 * 60_000)
    await expect(fresh.hello({
      challenge: minted,
      identity: { ...initiator },
      proof: { publicKey: expiryKey.publicKey, signature: expiryKey.sign(peerHelloMessage(initiator.instanceId, minted)) },
    })).rejects.toThrowError(/CHALLENGE_EXPIRED/)
  } finally {
    vi.useRealTimers()
  }
})

it('rejects unknown, reused, and stale challenges; forged proofs; and foreign keys', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  const { peerHost: host } = await mount(root)
  const key = identityKey()
  const challenge = (await host.challenge()).challenge
  await expect(handshake(host, { key, challenge: 'never-minted' })).rejects.toThrowError(/CHALLENGE_EXPIRED/)
  await expect(handshake(host, { key, challenge })).resolves.toBeDefined()
  await expect(handshake(host, { key, challenge })).rejects.toThrowError(/CHALLENGE_EXPIRED/)
  const second = (await host.challenge()).challenge
  const foreign = identityKey()
  await expect(host.hello({
    challenge: second,
    identity: { ...initiator },
    proof: { publicKey: foreign.publicKey, signature: foreign.sign(peerHelloMessage(initiator.instanceId, second)) },
  })).rejects.toThrowError(/IDENTITY_MISMATCH/)
  const third = (await host.challenge()).challenge
  await expect(host.hello({
    challenge: third,
    identity: { ...initiator },
    proof: { publicKey: key.publicKey, signature: key.sign(peerHelloMessage(initiator.instanceId, third).toUpperCase()) },
  })).rejects.toThrowError(/INVALID_PROOF/)
})

it('pins a pre-proof record on its first proof-bearing hello', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  const { peerHost: host } = await mount(root)
  await writePeerStore(root, [{ ...initiator, surface: { delegate: true, message: true, list: true }, pairedVia: 'invitation', status: 'active', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' }])
  const key = identityKey()
  await expect(handshake(host, { key })).resolves.toBeDefined()
  expect((await readPeerStore(root))[0]!.identityPublicKey).toBe(key.publicKey)
})

it('rejects invalid hellos, revoked peers, VM worlds, and missing self identity', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  const { peerHost: host } = await mount(root)
  const key = identityKey()
  const challenge = (await host.challenge()).challenge
  const proof = { publicKey: key.publicKey, signature: key.sign(peerHelloMessage(initiator.instanceId, challenge)) }
  await expect(host.hello({ challenge, identity: { ...initiator, displayName: '' }, proof })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ challenge, identity: { ...initiator, arch: '' }, proof })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ challenge, identity: { ...initiator, version: 5 as never }, proof })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ challenge, identity: { ...initiator, platform: {} as never }, proof })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ identity: { ...initiator }, proof } as never)).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ challenge, proof } as never)).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ challenge, identity: { ...initiator, extra: true }, proof } as never)).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ challenge, identity: { ...initiator, instanceId: 5 as never }, proof })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello(null as never)).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello([] as never)).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ challenge, identity: { ...initiator, displayName: 'x'.repeat(65) }, proof })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ challenge: 'x'.repeat(200), identity: { ...initiator }, proof })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({
    challenge, identity: { ...initiator }, proof: { publicKey: '', signature: '' },
  })).rejects.toThrowError(/INVALID_HELLO/)
  const fresh = (await host.challenge()).challenge
  await host.hello({
    challenge: fresh,
    identity: { ...initiator },
    proof: { publicKey: key.publicKey, signature: key.sign(peerHelloMessage(initiator.instanceId, fresh)) },
  })
  await writePeerStore(root, (await readPeerStore(root)).map(peer => ({ ...peer, status: 'revoked' as const })))
  await expect(handshake(host, { key })).rejects.toThrowError(/HELLO_REJECTED/)
  process.env.DSH_EXEC_WORLD = 'vm'
  try {
    await writePeerStore(root, [])
    await expect(host.challenge()).rejects.toThrowError(/PEER_UNAVAILABLE_VM/)
    await expect(handshake(host, { key })).rejects.toThrowError(/PEER_UNAVAILABLE_VM/)
  } finally {
    delete process.env.DSH_EXEC_WORLD
  }
  const bare = await home()
  const bareCtx = await mount(bare)
  await expect(handshake(bareCtx.peerHost)).rejects.toThrowError(/CORRUPT_INSTANCE/)
})

it('removes one paired record, reports the final state, and rejects unknown ids', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  const ctx = await mount(root)
  const host = ctx.peerHost
  await handshake(host)
  const removed: PeerRecord[] = []
  ctx.on('peer/removed', (record: PeerRecord) => { removed.push(record) })
  const record = await host.removePeer(initiator.instanceId)
  expect(record.instanceId).toBe(initiator.instanceId)
  expect(await readPeerStore(root)).toEqual([])
  expect(removed).toHaveLength(1)
  await expect(host.removePeer(initiator.instanceId)).rejects.toThrowError(/RECORD_NOT_FOUND/)
})

it('stores and revalidates peer records through the durable store file', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  expect(await readPeerStore(root)).toEqual([])
  const { peerHost: host } = await mount(root)
  await handshake(host)
  const stored = (await readPeerStore(root))[0]!
  expect(() => parsePeerRecord({ ...stored, status: 'other' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerRecord({ ...stored, missing: true })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerRecord({ ...stored, surface: { delegate: true } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerRecord({ ...stored, identityPublicKey: 5 as never })).toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(peerStorePath(root), 'not json')
  await expect(readPeerStore(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
})

it('maps store write failures onto the closed reason', async () => {
  const root = await home()
  const block = join(root, 'block')
  await writeFile(block, 'a plain file blocks recursive directory creation')
  await expect(writePeerStore(join(block, 'under'), [])).rejects.toThrowError(/STORE_FAILED/)
  await expect(mount(join(root, 'unwritable'))).resolves.toBeDefined()
  void PeerError
})

/** One request proof minted for the pinned initiator key. */
function requestProof(key: ReturnType<typeof identityKey>): { instanceId: string; timestamp: number; nonce: string; signature: string } {
  const timestamp = Date.now()
  const nonce = randomUUID()
  const message = peerRequestMessage(initiator.instanceId, timestamp, nonce)
  return { instanceId: initiator.instanceId, timestamp, nonce, signature: key.sign(message) }
}

/** One mounted host whose peer store carries the pinned initiator. */
async function pairedHost(): Promise<{ host: PeerHost; key: ReturnType<typeof identityKey>; root: string }> {
  const root = await home()
  const key = identityKey()
  const record: PeerRecord = {
    instanceId: initiator.instanceId, displayName: initiator.displayName, platform: initiator.platform,
    arch: initiator.arch, version: initiator.version,
    surface: { delegate: true, message: true, list: true }, pairedVia: 'invitation', status: 'active',
    identityPublicKey: key.publicKey, firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
  }
  await writePeerStore(root, [record])
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(PeerHost, { dshHome: root })
  return { host: ctx.peerHost, key, root }
}

it('subscribes the paired peer and rejects replayed proof nonces', async () => {
  const { host, key } = await pairedHost()
  const proof = requestProof(key)
  const granted = await host.subscribe({ proof })
  expect(granted.streamToken.length).toBeGreaterThan(0)
  expect(granted.heartbeatMs).toBeGreaterThan(0)
  await expect(host.subscribe({ proof })).rejects.toThrowError(/replayed nonce/)
  await expect(host.subscribe({ proof: requestProof({ ...key, sign: () => 'bad' }) })).rejects.toThrowError(/INVALID_PROOF/)
})

it('denies cancel and subscribe under restricted surfaces', async () => {
  const { host, key } = await pairedHost()
  const peers = await readPeerStore(host.home)
  await writePeerStore(host.home, [
    { ...peers[0]!, surface: { delegate: false, message: false, list: false } },
  ])
  await expect(host.cancel({ proof: requestProof(key), sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef' }))
    .rejects.toThrowError(/SURFACE_DENIED/)
  await expect(host.subscribe({ proof: requestProof(key) })).rejects.toThrowError(/SURFACE_DENIED/)
})

it('serves the event stream route through single-use tokens', async () => {
  const root = await home()
  const key = identityKey()
  const record: PeerRecord = {
    instanceId: initiator.instanceId, displayName: initiator.displayName, platform: initiator.platform,
    arch: initiator.arch, version: initiator.version,
    surface: { delegate: true, message: true, list: true }, pairedVia: 'invitation', status: 'active',
    identityPublicKey: key.publicKey, firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
  }
  await writePeerStore(root, [record])
  const routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }> = []
  const ctx = new Context()
  ctx.provide('webServer', {
    register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) => {
      routes.push(route)
      return () => routes.splice(routes.indexOf(route), 1)
    },
  })
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(PeerHost, { dshHome: root })
  expect(routes.map(route => ({ kind: route.kind, path: route.path }))).toEqual([{ kind: 'exact', path: '/api/peer/events' }])
  expect(routes[0]!.handler).toBeInstanceOf(Function)

  /** One capture-style response recorder. */
  interface FakeResponseSink {
    res: {
      writeHead(status: number, headers: Record<string, string>): void
      write(chunk: string): void
      end(): void
      on(event: 'close', listener: () => void): void
    }
    chunks: string[]
    status: number
    headers: Record<string, string>
    ended: boolean
    close(): void
  }

  const fakeResponse = (): FakeResponseSink => {
    const state = { chunks: [] as string[], status: 0, headers: {} as Record<string, string>, ended: false, listener: (): void => {} }
    return {
      res: {
        writeHead: (status: number, headers: Record<string, string>) => { state.status = status; state.headers = headers },
        write: (chunk: string) => { state.chunks.push(chunk) },
        end: () => { state.ended = true },
        on: (_event: 'close', listener: () => void) => { state.listener = listener },
      },
      get chunks() { return state.chunks },
      get status() { return state.status },
      get headers() { return state.headers },
      get ended() { return state.ended },
      close: () => { state.listener() },
    }
  }

  const handler = routes[0]!.handler
  const host = ctx.peerHost
  const { streamToken } = await host.subscribe({ proof: requestProof(key) })
  const refused = fakeResponse()
  await handler({ method: 'GET', url: '/api/peer/events?token=unknown' }, refused.res)
  expect(refused.status).toBe(403)
  expect(refused.ended).toBe(true)
  const wrongMethod = fakeResponse()
  await handler({ method: 'POST', url: '/api/peer/events' }, wrongMethod.res)
  expect(wrongMethod.status).toBe(403)
  const live = fakeResponse()
  const streamingOutcome = handler({ method: 'GET', url: `/api/peer/events?token=${encodeURIComponent(streamToken)}` }, live.res)
  const streaming = Promise.resolve(streamingOutcome)
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(live.status).toBe(200)
  expect(live.headers['content-type']).toBe('text/event-stream')
  live.close()
  await streaming
  expect(live.ended).toBe(true)
  const replayed = fakeResponse()
  await handler({ method: 'GET', url: `/api/peer/events?token=${encodeURIComponent(streamToken)}` }, replayed.res)
  expect(replayed.status).toBe(403)
  const bare = fakeResponse()
  await handler({ method: 'GET', url: '/api/peer/events' }, bare.res)
  expect(bare.status).toBe(403)
  const urlless = fakeResponse()
  await handler({ method: 'GET' }, urlless.res)
  expect(urlless.status).toBe(403)

  // A registry session plus a live turn/end pushes one frame through the route's sink.
  const { writePeerSessions } = await import('../src/session-registry.ts')
  const second = await host.subscribe({ proof: requestProof(key) })
  await writePeerSessions(root, [{
    sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', peerInstanceId: initiator.instanceId,
    createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', cwd: root, label: 'seed',
  }])
  const framed = fakeResponse()
  const pushingOutcome = handler({ method: 'GET', url: `/api/peer/events?token=${encodeURIComponent(second.streamToken)}` }, framed.res)
  const pushing = Promise.resolve(pushingOutcome)
  await new Promise(resolve => setTimeout(resolve, 5))
  ctx.emit('session/event', { id: 'peer-01234567-89ab-cdef-0123-456789abcdef' } as never, { type: 'turn/end', data: { turn: 't', reason: { kind: 'completed' } } } as never)
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(framed.chunks).toEqual(['data: {"kind":"settled","sessionId":"peer-01234567-89ab-cdef-0123-456789abcdef"}\n\n'])
  framed.close()
  await pushing
})
