/** Durable delegated-session registry: corpus validation, atomic writes, and lookups. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeInstanceIdentity } from '@deepseek-ai/dsh-peer-protocol'
import { peerSessionsPath, parsePeerSessionEntry, readPeerSessions, writePeerSessions } from '../src/session-registry.ts'
import type { PeerSessionEntry } from '../src/session-registry.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'peer-sessions-'))
  directories.push(path)
  return path
}

const entry: PeerSessionEntry = {
  sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef',
  peerInstanceId: '3f2a8f9e-1111-4222-8333-444455556666',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: '2026-01-01T00:00:01.000Z',
  cwd: '/tmp/work',
  label: 'summarize the tree',
}

it('treats an absent or empty registry as empty and round-trips entries', async () => {
  const root = await home()
  expect(await readPeerSessions(root)).toEqual([])
  await writeFile(peerSessionsPath(root), '   ')
  expect(await readPeerSessions(root)).toEqual([])
  await writePeerSessions(root, [entry])
  expect(await readPeerSessions(root)).toEqual([entry])
})

it('rejects malformed documents with the closed reason', async () => {
  const root = await home()
  await writeFile(peerSessionsPath(root), 'not json')
  await expect(readPeerSessions(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(peerSessionsPath(root), '[]')
  await expect(readPeerSessions(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  await writeFile(peerSessionsPath(root), JSON.stringify({ version: 2, sessions: [] }))
  await expect(readPeerSessions(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
})

it('revalidates every stored entry field', () => {
  expect(() => parsePeerSessionEntry(null)).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerSessionEntry('peer-01234567-89ab-cdef-0123-456789abcdef')).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerSessionEntry({ ...entry, extra: true })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerSessionEntry({ ...entry, missing: true })).toThrowError(/CORRUPT_INSTANCE/)
  expect(() => parsePeerSessionEntry({ ...entry, sessionId: 'chat-1' })).toThrowError(/peer session entry id/)
  expect(() => parsePeerSessionEntry({ ...entry, sessionId: 'x'.repeat(81) })).toThrowError(/peer session entry id/)
  expect(() => parsePeerSessionEntry({ ...entry, peerInstanceId: 'nope' })).toThrowError(/peer session entry owner/)
  expect(() => parsePeerSessionEntry({ ...entry, cwd: '' })).toThrowError(/peer session entry fields/)
  expect(() => parsePeerSessionEntry({ ...entry, cwd: 'x'.repeat(513) })).toThrowError(/peer session entry fields/)
  expect(() => parsePeerSessionEntry({ ...entry, label: 'x'.repeat(65) })).toThrowError(/peer session entry fields/)
  expect(() => parsePeerSessionEntry({ ...entry, createdAt: 'nope' })).toThrowError(/peer session entry fields/)
  expect(() => parsePeerSessionEntry({ ...entry, lastActivityAt: 5 as never })).toThrowError(/peer session entry fields/)
  expect(() => parsePeerSessionEntry({ ...entry, profile: '' })).toThrowError(/peer session entry profile/)
  expect(() => parsePeerSessionEntry({ ...entry, profile: 'x'.repeat(129) })).toThrowError(/peer session entry profile/)
  expect(parsePeerSessionEntry({ ...entry, profile: 'standard' })).toMatchObject({ profile: 'standard' })
})

it('maps registry write failures onto the closed reason', async () => {
  const root = await home()
  await writeFile(join(root, 'block'), 'a plain file blocks recursive directory creation')
  await expect(writePeerSessions(join(root, 'block', 'under'), [])).rejects.toThrowError(/STORE_FAILED/)
  void writeInstanceIdentity
})
