import { generateKeyPairSync, sign } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PeerError, ensureInstanceIdentity, peerHelloMessage, peerInstanceId } from '@deepseek-ai/dsh-peer-protocol'
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
