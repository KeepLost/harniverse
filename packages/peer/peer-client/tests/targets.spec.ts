import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import { findPeerTarget, parsePeerTarget, peerTargetsPath, readPeerTargets, writePeerTargets } from '../src/index.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'peer-targets-'))
  directories.push(path)
  return path
}

const target: PeerTarget = {
  targetInstanceId: '3f2a8f9e-1111-4222-8333-444455556666',
  displayName: 'Build workstation',
  endpoint: { origin: 'https://build.example.org:8443' },
  transport: { kind: 'direct' },
  grantName: 'peer-3f2a8f9e-1111-4222-8333-444455556666',
  grantId: 'ZAmaIsTHXZPHHDnV',
  status: 'active',
  addedAt: '2026-11-18T08:00:00.000Z',
}

it('round-trips the target store through an empty-file and fresh-home read', async () => {
  const root = await home()
  expect(await readPeerTargets(root)).toEqual([])
  await writeFile(peerTargetsPath(root), '   ')
  expect(await readPeerTargets(root)).toEqual([])
  await writePeerTargets(root, [target])
  expect(await readPeerTargets(root)).toEqual([target])
  expect(findPeerTarget(await readPeerTargets(root), target.targetInstanceId)).toEqual(target)
  expect(findPeerTarget(await readPeerTargets(root), '99999999-1111-4222-8333-444455556666')).toBeUndefined()
})

it('rejects malformed store documents with the closed corrupt reason', async () => {
  const root = await home()
  for (const body of ['not json', '[]', '{}', '{"version":2,"targets":[]}', '{"version":1,"targets":{}}']) {
    await writeFile(peerTargetsPath(root), body)
    await expect(readPeerTargets(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  }
})

it('validates every target field through the parser', () => {
  expect(() => parsePeerTarget('x')).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerTarget([])).toThrowError(/CORRUPT_INSTANCE/)
  const bad = (patch: Record<string, unknown>): unknown => parsePeerTarget({ ...target as unknown as Record<string, unknown>, ...patch })
  expect(() => bad({ targetInstanceId: 'nope' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ displayName: '' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ displayName: 'x'.repeat(65) })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ grantName: '' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ grantName: 'x'.repeat(65) })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ grantId: '' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ grantId: 'x'.repeat(65) })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ status: 'other' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ addedAt: 'nope' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ endpoint: 'x' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ endpoint: { host: 'x' } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ endpoint: { origin: '' } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ transport: 'x' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ transport: { kind: 'vpn' } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ transport: { kind: 'ssh' } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ transport: { kind: 'ssh', host: '' } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ transport: { kind: 'ssh', host: 'box', extra: 1 } })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ tlsFingerprint: 'short' })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => bad({ missing: true })).toThrowError(/CORRUPT_INSTANCE/)
})

it('accepts an ssh transport and an optional TLS fingerprint with exact fields', () => {
  const ssh: PeerTarget = { ...target, transport: { kind: 'ssh', host: 'box' } }
  expect(parsePeerTarget({ ...ssh as unknown as Record<string, unknown> })).toEqual(ssh)
  const pinned: PeerTarget = { ...target, tlsFingerprint: 'A'.repeat(43) }
  expect(parsePeerTarget({ ...pinned as unknown as Record<string, unknown> })).toEqual(pinned)
})

it('maps store write failures onto the closed reason', async () => {
  const root = await home()
  const block = join(root, 'block')
  await writeFile(block, 'a plain file blocks recursive directory creation')
  await expect(writePeerTargets(join(block, 'under'), [])).rejects.toThrowError(PeerError)
})
