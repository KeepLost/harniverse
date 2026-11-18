import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PeerError, ensureInstanceIdentity, peerInstanceId } from '@deepseek-ai/dsh-peer-protocol'
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

it('answers hello with this instance identity and commits the first paired record', async () => {
  const root = await home()
  const self = await ensureInstanceIdentity(root)
  const ctx = await mount(root)
  const host = ctx.peerHost
  const paired: PeerRecord[] = []
  ctx.on('peer/paired', (record: PeerRecord) => { paired.push(record) })
  const hello = await host.hello({ ...initiator })
  expect(hello.instanceId).toBe(self.instanceId)
  expect(hello.surface).toEqual({ delegate: true, message: true, list: true })
  const peers = await readPeerStore(root)
  expect(peers).toHaveLength(1)
  expect(peers[0]).toMatchObject({ instanceId: initiator.instanceId, displayName: 'Laptop', status: 'active' })
  expect(paired).toHaveLength(1)
})

it('refreshes an existing peer without re-emitting the paired event', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  const { peerHost: host } = await mount(root)
  await host.hello({ ...initiator })
  const before = (await readPeerStore(root))[0]!
  await new Promise(resolve => setTimeout(resolve, 5))
  await host.hello({ ...initiator, displayName: 'Renamed' })
  const after = (await readPeerStore(root))[0]!
  expect(after.displayName).toBe('Renamed')
  expect(after.firstSeenAt).toBe(before.firstSeenAt)
  expect(Date.parse(after.lastSeenAt)).toBeGreaterThan(Date.parse(before.lastSeenAt))
})

it('rejects invalid hellos, revoked peers, VM worlds, and missing self identity', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  const { peerHost: host } = await mount(root)
  await expect(host.hello({ ...initiator, instanceId: peerInstanceId('3f2a8f9e-1111-4222-8333-444455556667'), displayName: '' }))
    .rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ ...initiator, extra: true } as never)).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ displayName: 'Laptop', platform: 'darwin', arch: 'arm64', version: '1' } as never))
    .rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ ...initiator, instanceId2: initiator.instanceId } as never)).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ ...initiator, instanceId: 5 as never })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello(null as never)).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello([] as never)).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ ...initiator, displayName: 'x'.repeat(65) })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ ...initiator, platform: 'x'.repeat(33) })).rejects.toThrowError(/INVALID_HELLO/)
  await expect(host.hello({ ...initiator, platform: '' })).rejects.toThrowError(/INVALID_HELLO/)
  await host.hello({ ...initiator })
  await writePeerStore(root, (await readPeerStore(root)).map(peer => ({ ...peer, status: 'revoked' as const })))
  await expect(host.hello({ ...initiator })).rejects.toThrowError(/HELLO_REJECTED/)
  process.env.DSH_EXEC_WORLD = 'vm'
  try {
    await writePeerStore(root, [])
    await expect(host.hello({ ...initiator })).rejects.toThrowError(/PEER_UNAVAILABLE_VM/)
  } finally {
    delete process.env.DSH_EXEC_WORLD
  }
  const bare = await home()
  const bareCtx = await mount(bare)
  await expect(bareCtx.peerHost.hello({ ...initiator })).rejects.toThrowError(/CORRUPT_INSTANCE/)
})

it('removes one paired record, reports the final state, and rejects unknown ids', async () => {
  const root = await home()
  await ensureInstanceIdentity(root)
  const ctx = await mount(root)
  const host = ctx.peerHost
  await host.hello({ ...initiator })
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
  await host.hello({ ...initiator })
  const stored = (await readPeerStore(root))[0]!
  expect(() => parsePeerRecord({ ...stored, status: 'other' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerRecord({ ...stored, missing: true })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerRecord({ ...stored, surface: { delegate: true } })).toThrowError(/CORRUPT_INSTANCE/)
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
