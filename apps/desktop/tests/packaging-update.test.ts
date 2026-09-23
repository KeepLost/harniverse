import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUpdate, transitionUpdate, recoverUpdate } from '../scripts/update-journal.ts'

const candidate = { current: '1.0.0', next: '1.1.0', artifact: 'Harniverse.AppImage', sha256: 'a'.repeat(64) }

void test('installation requires consent, admission closure, drain, and an awaited owned host stop', () => {
  const offered = createUpdate(candidate)
  assert.throws(() => transitionUpdate(offered, { type: 'begin-install' }), /transition/)
  const consented = transitionUpdate(offered, { type: 'consent' })
  assert.equal(consented.state, 'draining')
  assert.throws(() => transitionUpdate(consented, { type: 'drained', activeWork: 2, admissionClosed: true, ownedHost: true }), /active work/)
  assert.throws(() => transitionUpdate(consented, { type: 'drained', activeWork: 0, admissionClosed: false, ownedHost: true }), /admission/)
  const stopping = transitionUpdate(consented, { type: 'drained', activeWork: 0, admissionClosed: true, ownedHost: true })
  assert.equal(stopping.state, 'stopping-owned-host')
  assert.throws(() => transitionUpdate(stopping, { type: 'begin-install' }), /transition/)
  const ready = transitionUpdate(stopping, { type: 'owned-host-stopped' })
  const installing = transitionUpdate(ready, { type: 'begin-install' })
  assert.equal(installing.rollbackVersion, '1.0.0')
  const probing = transitionUpdate(installing, { type: 'installed' })
  assert.equal(transitionUpdate(probing, { type: 'healthy' }).state, 'complete')
  assert.equal(offered.entries.length, 1)
})

void test('an attached host is never stopped and failed installation preserves rollback evidence', () => {
  let journal = transitionUpdate(createUpdate(candidate), { type: 'consent' })
  journal = transitionUpdate(journal, { type: 'drained', activeWork: 0, admissionClosed: true, ownedHost: false })
  assert.equal(journal.state, 'ready')
  assert.throws(() => transitionUpdate(journal, { type: 'owned-host-stopped' }), /transition/)
  journal = transitionUpdate(journal, { type: 'begin-install' })
  journal = transitionUpdate(journal, { type: 'failed', reason: 'health probe failed' })
  assert.equal(journal.state, 'rollback-required')
  assert.equal(journal.rollbackVersion, candidate.current)
  assert.equal(transitionUpdate(journal, { type: 'rolled-back' }).state, 'rolled-back')
})

void test('restart demands fresh consent before install and rollback after an interrupted install', () => {
  const offered = createUpdate(candidate)
  assert.equal(recoverUpdate(JSON.parse(JSON.stringify(offered))).state, 'awaiting-consent')
  let journal = transitionUpdate(offered, { type: 'consent' })
  journal = transitionUpdate(journal, { type: 'drained', activeWork: 0, admissionClosed: true, ownedHost: false })
  assert.equal(recoverUpdate(journal).state, 'awaiting-consent')
  journal = transitionUpdate(journal, { type: 'begin-install' })
  assert.equal(recoverUpdate(journal).state, 'rollback-required')
  assert.throws(() => recoverUpdate({ ...journal, state: 'complete' }), /journal/)
  assert.throws(() => recoverUpdate({ schemaVersion: 99 }), /journal/)
})

void test('decline, drain failures, and invalid artifact metadata cannot install', () => {
  assert.equal(transitionUpdate(createUpdate(candidate), { type: 'decline' }).state, 'declined')
  const draining = transitionUpdate(createUpdate(candidate), { type: 'consent' })
  assert.equal(transitionUpdate(draining, { type: 'failed', reason: 'drain timed out' }).state, 'failed')
  assert.throws(() => createUpdate({ ...candidate, sha256: 'unverified' }), /SHA-256/)
  assert.throws(() => createUpdate({ ...candidate, artifact: '../other' }), /artifact/)
})
