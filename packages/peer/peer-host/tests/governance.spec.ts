/** Turn-budget governance: durable store, authorization gate, and usage recording. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerInstanceId } from '@deepseek-ai/dsh-peer-protocol'
import {
  authorizePeerTurn, isNarrowing, parsePeerGovernanceEntry, peerBudgetView, peerGovernancePath,
  periodOf, readPeerGovernance, recordPeerTurn, setPeerBudget, writePeerGovernance,
} from '../src/governance.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'peer-governance-'))
  directories.push(path)
  return path
}

const peer = '3f2a8f9e-1111-4222-8333-444455556666' as PeerInstanceId

it('round-trips entries through the durable store and treats an absent file as empty', async () => {
  const root = await home()
  expect(await readPeerGovernance(root)).toEqual([])
  await writePeerGovernance(root, [{ instanceId: peer, monthlyTurns: 5, spent: { '2026-11': 2 } }])
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: peer, monthlyTurns: 5, spent: { '2026-11': 2 } }])
  expect((await readFile(peerGovernancePath(root), 'utf8')).trim()).toBe('{"version":1,"entries":[{"instanceId":"3f2a8f9e-1111-4222-8333-444455556666","monthlyTurns":5,"spent":{"2026-11":2}}]}')
})

it('rejects malformed governance documents and entries with the closed reason', async () => {
  const root = await home()
  await writeFile(peerGovernancePath(root), 'not json', 'utf8')
  await expect(readPeerGovernance(root)).rejects.toThrowError(/CORRUPT_INSTANCE/)
  for (const [document, label] of [
    ['[]', 'array'],
    ['{"version":2,"entries":[]}', 'version'],
    ['{"version":1,"entries":[{"instanceId":"nope","spent":{}}]}', 'owner'],
    ['{"version":1,"entries":[{"instanceId":"3f2a8f9e-1111-4222-8333-444455556666","spent":{},"monthlyTurns":0}]}', 'budget low'],
    ['{"version":1,"entries":[{"instanceId":"3f2a8f9e-1111-4222-8333-444455556666","spent":{},"monthlyTurns":1.5}]}', 'budget fractional'],
    ['{"version":1,"entries":[{"instanceId":"3f2a8f9e-1111-4222-8333-444455556666"}]}', 'missing spent'],
    ['{"version":1,"entries":[{"instanceId":"3f2a8f9e-1111-4222-8333-444455556666","spent":{"2026-1":1}}]}', 'period shape'],
    ['{"version":1,"entries":[{"instanceId":"3f2a8f9e-1111-4222-8333-444455556666","spent":{"2026-11":-1}}]}', 'negative turns'],
  ] as const) {
    await writeFile(peerGovernancePath(root), document, 'utf8')
    await expect(readPeerGovernance(root), label).rejects.toThrowError(/CORRUPT_INSTANCE/)
  }
  expect(() => parsePeerGovernanceEntry('nope')).toThrowError(/CORRUPT_INSTANCE/)
})

it('treats a blank governance file as empty and bounds parsed periods', async () => {
  const root = await home()
  await writeFile(peerGovernancePath(root), '   ', 'utf8')
  expect(await readPeerGovernance(root)).toEqual([])
  const spent: Record<string, number> = {}
  for (let index = 0; index < 25; index += 1) spent[`2025-${(index % 12 + 1).toString().padStart(2, '0')}-${index}`] = 1
  await writeFile(peerGovernancePath(root), JSON.stringify({ version: 1, entries: [{ instanceId: peer, spent }] }), 'utf8')
  await expect(readPeerGovernance(root)).rejects.toThrowError(/spent periods/)
  await writeFile(peerGovernancePath(root), JSON.stringify({ version: 1, entries: [{ instanceId: peer, spent: [] }] }), 'utf8')
  await expect(readPeerGovernance(root)).rejects.toThrowError(/spent/)
})

it('maps governance write failures onto the closed reason', async () => {
  const root = await home()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'block'), 'a plain file blocks recursive directory creation', 'utf8')
  await expect(writePeerGovernance(join(root, 'block', 'under'), [])).rejects.toThrowError(/STORE_FAILED/)
})

it('keeps other peers untouched while recording and editing one peer', async () => {
  const root = await home()
  const other = '3f2a8f9e-9999-4222-8333-444455557777' as PeerInstanceId
  await writePeerGovernance(root, [{ instanceId: other, spent: { '2026-11': 9 } }])
  await recordPeerTurn(root, peer, new Date('2026-11-21T12:00:00.000Z'))
  await recordPeerTurn(root, peer, new Date('2026-11-21T12:00:00.000Z'))
  await setPeerBudget(root, peer, 4)
  expect(await readPeerGovernance(root)).toContainEqual({ instanceId: other, spent: { '2026-11': 9 } })
})

it('labels UTC calendar periods', () => {
  expect(periodOf(new Date(Date.UTC(2026, 10, 21, 3, 4, 5)))).toBe('2026-11')
  expect(periodOf(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('2026-01')
  expect(periodOf(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe('2026-12')
})

it('classifies desired surfaces by whether any field widens', () => {
  const full = { delegate: true, message: true, list: true }
  expect(isNarrowing(full, { delegate: false, message: true, list: false })).toBe(true)
  expect(isNarrowing(full, full)).toBe(true)
  expect(isNarrowing(full, { delegate: false, message: false, list: true })).toBe(true)
  expect(isNarrowing({ delegate: false, message: true, list: true }, { delegate: false, message: true, list: true })).toBe(true)
  expect(isNarrowing({ delegate: false, message: true, list: true }, { delegate: true, message: false, list: false })).toBe(false)
})

it('authorizes turns against the current period and rejects exhausted budgets', async () => {
  const root = await home()
  const now = new Date('2026-11-21T12:00:00.000Z')
  await authorizePeerTurn(root, peer, now)
  await authorizePeerTurn(root, peer, now)
  await writePeerGovernance(root, [{ instanceId: peer, monthlyTurns: 2, spent: { '2026-11': 1 } }])
  await authorizePeerTurn(root, peer, now)
  await writePeerGovernance(root, [{ instanceId: peer, monthlyTurns: 2, spent: { '2026-11': 2 } }])
  await expect(authorizePeerTurn(root, peer, now)).rejects.toThrowError(/BUDGET_EXCEEDED \(2026-11 limit 2\)/)
  await expect(authorizePeerTurn(root, peer, new Date('2026-12-01T00:00:00.000Z'))).resolves.toBeUndefined()
})

it('records accepted turns, creating and pruning period buckets', async () => {
  const root = await home()
  const november = new Date('2026-11-21T12:00:00.000Z')
  await recordPeerTurn(root, peer, november)
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: peer, spent: { '2026-11': 1 } }])
  await recordPeerTurn(root, peer, november)
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: peer, spent: { '2026-11': 2 } }])
  const january = new Date('2027-01-05T00:00:00.000Z')
  await writePeerGovernance(root, [{ instanceId: peer, monthlyTurns: 9, spent: { '2026-11': 2, '2026-12': 7 } }])
  await recordPeerTurn(root, peer, january)
  // January keeps only itself plus December; November falls out of the retention window.
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: peer, monthlyTurns: 9, spent: { '2026-12': 7, '2027-01': 1 } }])
})

it('summarizes one peer budget for the admin view', async () => {
  const root = await home()
  const now = new Date('2026-11-21T12:00:00.000Z')
  expect(await peerBudgetView(root, peer, now)).toEqual({ monthlyTurnsUsed: 0, monthlyTurnPeriod: '2026-11' })
  await writePeerGovernance(root, [{ instanceId: peer, monthlyTurns: 3, spent: { '2026-10': 9, '2026-11': 1 } }])
  expect(await peerBudgetView(root, peer, now)).toEqual({ monthlyTurns: 3, monthlyTurnsUsed: 1, monthlyTurnPeriod: '2026-11' })
})

it('sets and lifts budgets, dropping entries that become inert', async () => {
  const root = await home()
  await setPeerBudget(root, peer, undefined)
  expect(await readPeerGovernance(root)).toEqual([])
  await setPeerBudget(root, peer, 7)
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: peer, monthlyTurns: 7, spent: {} }])
  await setPeerBudget(root, peer, 9)
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: peer, monthlyTurns: 9, spent: {} }])
  // An entry with recorded usage stays after the cap lifts; usage remains readable.
  await recordPeerTurn(root, peer, new Date('2026-11-21T12:00:00.000Z'))
  await setPeerBudget(root, peer, undefined)
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: peer, spent: { '2026-11': 1 } }])
  // Once a fresh period resets usage, lifting the cap lets the entry go inert and drop.
  await writePeerGovernance(root, [{ instanceId: peer, spent: {} }])
  await setPeerBudget(root, peer, undefined)
  expect(await readPeerGovernance(root)).toEqual([])
  void PeerError
})
