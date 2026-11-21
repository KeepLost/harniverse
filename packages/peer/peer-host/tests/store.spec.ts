import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { PeerRecord } from '@deepseek-ai/dsh-peer-protocol'
import { parsePeerRecord, peerStorePath, readPeerStore, writePeerStore } from '../src/store.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'peer-store-'))
  directories.push(path)
  return path
}

const record: PeerRecord = {
  instanceId: '3f2a8f9e-1111-4222-8333-444455556666',
  displayName: 'Laptop',
  platform: 'darwin',
  arch: 'arm64',
  version: '1.0.0-rc.3',
  surface: { delegate: true, message: true, list: true, artifacts: true },
  pairedVia: 'invitation',
  status: 'active',
  firstSeenAt: '2026-11-18T08:00:00.000Z',
  lastSeenAt: '2026-11-18T08:00:00.000Z',
}

it('treats an absent and a blank store file as empty', async () => {
  const root = await home()
  expect(await readPeerStore(root)).toEqual([])
  await writeFile(peerStorePath(root), '  ')
  expect(await readPeerStore(root)).toEqual([])
})

it('round-trips one record through the store file', async () => {
  const root = await home()
  await writePeerStore(root, [record])
  expect(await readPeerStore(root)).toEqual([record])
})

it('rejects malformed store documents with the closed corrupt reason', async () => {
  const root = await home()
  for (const body of ['not json', '[]', '{}', '{"version":2,"peers":[]}', '{"version":1,"peers":{}}']) {
    await writeFile(peerStorePath(root), body)
    await expect(readPeerStore(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  }
})

it('validates every record field through the parser', () => {
  expect(() => parsePeerRecord('x')).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerRecord([])).toThrowError(/CORRUPT_INSTANCE/)
  const bad = (patch: Record<string, unknown>): unknown =>
    parsePeerRecord({ ...record as unknown as Record<string, unknown>, ...patch })
  expect(() => bad({ instanceId: 'nope' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ displayName: '' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ displayName: 'x'.repeat(65) })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ platform: '' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ platform: 'x'.repeat(33) })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ arch: '' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ arch: 'x'.repeat(17) })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ version: '' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ version: 'x'.repeat(33) })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ surface: 'x' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ surface: [] })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ surface: { delegate: true } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ surface: { delegate: true, message: true, list: 'yes' } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ surface: { delegate: true, message: true, list: true, artifacts: 'yes' } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ surface: { delegate: true, message: true, list: true, extra: true } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ pairedVia: 'manual' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ status: 'other' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ firstSeenAt: 'nope' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ lastSeenAt: 'nope' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ extra: 1 })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ pendingSurface: 'x' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ pendingSurface: [] })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ pendingSurface: { delegate: true } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ pendingSurface: { delegate: true, message: true, list: 'yes' } })).toThrowError(/CORRUPT_INSTANCE/)
})

it('round-trips parked pending surfaces and keeps them optional', () => {
  expect(parsePeerRecord(record)).toEqual(record)
  const parked = parsePeerRecord({ ...record, pendingSurface: { delegate: true, message: false, list: true, artifacts: false } })
  expect(parked.pendingSurface).toEqual({ delegate: true, message: false, list: true, artifacts: false })
  expect('pendingSurface' in parked).toBe(true)
})

it('reads pre-artifact three-field surfaces back with artifacts defaulted off', () => {
  const legacy = { ...record as unknown as Record<string, unknown>, surface: { delegate: true, message: true, list: false } }
  const parsed = parsePeerRecord(legacy)
  expect(parsed.surface).toEqual({ delegate: true, message: true, list: false, artifacts: false })
})

it('maps store write failures onto the closed reason', async () => {
  const root = await home()
  const block = join(root, 'block')
  await writeFile(block, 'a plain file blocks recursive directory creation')
  await expect(writePeerStore(join(block, 'under'), [])).rejects.toThrowError(/STORE_FAILED/)
})
