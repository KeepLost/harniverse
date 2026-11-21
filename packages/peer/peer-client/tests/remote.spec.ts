/** Remote operations: proofs, the shared envelope, error mapping, and readback validation. */

import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { peerInstanceId, peerRequestMessage } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import {
  accessFor,
  provenHello,
  requestProofFor,
  runPeerDelegate,
  runPeerFollowup,
  runPeerResult,
  runPeerSessions,
  runPeerSurface,
} from '../src/remote.ts'
import { ensurePeerIdentityKey } from '../src/keys.ts'
import { ensureInstanceIdentity } from '@deepseek-ai/dsh-peer-protocol'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'peer-remote-'))
  directories.push(path)
  return path
}

const target: PeerTarget = {
  targetInstanceId: peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666'),
  displayName: 'Build workstation',
  endpoint: { origin: 'http://127.0.0.1:42001' },
  transport: { kind: 'direct' },
  grantName: 'peer-3f2a8f9e-1111-4222-8333-444455556666',
  grantId: 'grant-1',
  status: 'active',
  addedAt: '2026-01-01T00:00:00.000Z',
}

/** Resolve one home's call identity: instance anchor plus signing key. */
async function identityOf(homePath: string): Promise<{ instanceId: string; key: Awaited<ReturnType<typeof ensurePeerIdentityKey>> }> {
  const identity = await ensureInstanceIdentity(homePath)
  return { instanceId: identity.instanceId, key: await ensurePeerIdentityKey(homePath) }
}

/** One scripted fetch answering per-call envelopes in order, echoing peer rpc ids. */
function scripted(responses: Array<{ status?: number; body?: unknown; raw?: string; delayMs?: number }>): typeof globalThis.fetch {
  let index = 0
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = responses[Math.min(index, responses.length - 1)]!
    index += 1
    if (reply.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, reply.delayMs))
    if (reply.raw !== undefined) return new Response(reply.raw, { status: reply.status ?? 200 })
    let body = reply.body === undefined ? {} : reply.body
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (typeof url === 'string' && /\/api\/peer\/(hello|challenge|delegate|followup|result|sessions|surface)$/.test(url) && init?.body !== undefined) {
      const request = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { rpcId?: string }
      if (typeof request.rpcId === 'string' && typeof body === 'object' && body !== null) {
        body = { ...body as Record<string, unknown>, rpcId: request.rpcId }
      }
    }
    return new Response(JSON.stringify(body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  })
}

/** The approved token-exchange prefix every first authenticated call consumes. */
const exchange = [
  { body: { id: 'cha', payload: 'c2lnbg', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
  { body: { accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
]

const runResult = { sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'done', endReason: 'completed' }

it('builds transports from the global fetch when none is supplied', async () => {
  const root = await home()
  const identity = await identityOf(root)
  const options = { target, home: root, origin: 'http://127.0.0.1:1', timeoutMs: 250 }
  const access = accessFor(options, identity.key)
  expect(access).toBeDefined()
  // Port 1 refuses connections, so the default fetch path runs and the bounded timeout guards it.
  await expect(runPeerSessions(options, identity)).rejects.toThrowError()
})

it('mints request proofs over the canonical message', async () => {
  const root = await home()
  const identity = await identityOf(root)
  const proof = await requestProofFor(identity)
  expect(proof.instanceId).toBe(identity.instanceId)
  const message = peerRequestMessage(identity.instanceId, proof.timestamp, proof.nonce)
  const verify = sign('sha256', Buffer.from(message, 'utf8'), { key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, dsaEncoding: 'ieee-p1363' })
  expect(proof.signature).not.toBe(verify.toString('base64url'))
})

it('runs the challenge/hello exchange and the three operations through one envelope', async () => {
  const root = await home()
  const identity = await identityOf(root)
  const options = { target, home: root, origin: target.endpoint.origin }
  const access = accessFor({ ...options, fetch: scripted([
    ...exchange,
    { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { challenge: 'nonce' } } } },
    { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: target.targetInstanceId, displayName: 'T', platform: 'linux', arch: 'x64', version: '1',
      surface: { delegate: true, message: true, list: true },
    } } } },
  ]), timeoutMs: 5_000 }, identity.key)
  await expect(provenHello(access, options.origin, {
    instanceId: identity.instanceId, displayName: 'Laptop', platform: 'darwin', arch: 'arm64', version: '1',
  }, identity.key)).resolves.toMatchObject({ instanceId: target.targetInstanceId })

  const run = await runPeerDelegate({ ...options, fetch: scripted([...exchange, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: runResult } } }]), timeoutMs: 5_000 }, identity, 'summarize', { cwd: 'repo', profile: 'standard', timeoutMs: 1000 })
  expect(run).toMatchObject({ state: 'settled', reply: 'done' })
  const sent = await runPeerFollowup({ ...options, fetch: scripted([...exchange, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: runResult } } }]), timeoutMs: 5_000 }, identity, run.sessionId, 'again', 1000)
  expect(sent.state).toBe('settled')
  const sessionsBody = {
    sessions: [{
      sessionId: run.sessionId, createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:01.000Z', state: 'idle', label: 'summarize',
    }],
  }
  const sessionsFetch = scripted([...exchange, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: sessionsBody } } }])
  const sessions = await runPeerSessions({ ...options, fetch: sessionsFetch, timeoutMs: 5_000 }, identity)
  expect(sessions).toHaveLength(1)

  const read = await runPeerResult({ ...options, fetch: scripted([...exchange, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { ...runResult, state: 'running', reply: undefined } } } }]), timeoutMs: 5_000 }, identity, run.sessionId, run.messageId)
  expect(read).toMatchObject({ sessionId: run.sessionId, messageId: run.messageId, state: 'running' })
})

it('requests surface changes and validates the readback shape', async () => {
  const root = await home()
  const identity = await identityOf(root)
  const options = { target, home: root, origin: target.endpoint.origin, fetch: scripted([
    ...exchange,
    { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { surface: { delegate: true, message: false, list: false }, pending: false } } } },
  ]) }
  const committed = await runPeerSurface(options, identity, { delegate: true, message: false, list: false })
  expect(committed).toEqual({ surface: { delegate: true, message: false, list: false }, pending: false })
  const parkedOptions = { ...options, fetch: scripted([
    ...exchange,
    { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { surface: { delegate: true, message: true, list: false }, pending: true } } } },
  ]) }
  const parked = await runPeerSurface(parkedOptions, identity, { delegate: true, message: true, list: true })
  expect(parked).toEqual({ surface: { delegate: true, message: true, list: false }, pending: true })
  const malformed = { ...options, fetch: scripted([
    ...exchange,
    { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { surface: { delegate: true }, pending: false } } } },
  ]) }
  await expect(runPeerSurface(malformed, identity, { delegate: true, message: true, list: true }))
    .rejects.toThrowError(/INVALID_PAYLOAD/)
  const notObject = { ...options, fetch: scripted([
    ...exchange,
    { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: null } } },
  ]) }
  await expect(runPeerSurface(notObject, identity, { delegate: true, message: true, list: true }))
    .rejects.toThrowError(/INVALID_PAYLOAD/)
  const unpending = { ...options, fetch: scripted([
    ...exchange,
    { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { surface: { delegate: true, message: true, list: true } } } } },
  ]) }
  await expect(runPeerSurface(unpending, identity, { delegate: true, message: true, list: true }))
    .rejects.toThrowError(/INVALID_PAYLOAD/)
})

it('maps wire reasons, messages, statuses, and bodies onto the closed vocabulary', async () => {
  const root = await home()
  const identity = await identityOf(root)
  const options = { target, home: root, origin: target.endpoint.origin, timeoutMs: 5_000 }
  const denial = { body: { type: 'server-response', rpcId: 'x', result: { ok: false, error: { code: 'peer-failed', message: 'peer: SURFACE_DENIED (delegate)', details: { reason: 'SURFACE_DENIED' } } } } }
  await expect(runPeerDelegate({ ...options, fetch: scripted([...exchange, denial]) }, identity, 'p')).rejects.toThrowError(/SURFACE_DENIED/)
  const narrated = { body: { type: 'server-response', rpcId: 'x', result: { ok: false, error: { code: 'internal', message: 'peer: SESSION_BUSY' } } } }
  await expect(runPeerFollowup({ ...options, fetch: scripted([...exchange, narrated]) }, identity, runResult.sessionId, 'p')).rejects.toThrowError(/SESSION_BUSY/)
  const unmatched = { body: { type: 'server-response', rpcId: 'x', result: { ok: false, error: { code: 'internal', message: 'something else' } } } }
  const messageless = { body: { type: 'server-response', rpcId: 'x', result: { ok: false, error: { code: 'internal' } } } }
  const messagelessFetch = scripted([...exchange, messageless])
  await expect(runPeerFollowup({ ...options, fetch: messagelessFetch, timeoutMs: 5_000 }, identity, runResult.sessionId, 'p')).rejects.toThrowError(/TRANSPORT_FAILED/)
  const defaultTimeoutFetch = scripted([...exchange, unmatched])
  await expect(runPeerSessions({ target, home: root, origin: target.endpoint.origin, fetch: defaultTimeoutFetch }, identity))
    .rejects.toThrowError(/TRANSPORT_FAILED/)
  const unmatchedFetch = scripted([...exchange, unmatched])
  await expect(runPeerSessions({ ...options, fetch: unmatchedFetch }, identity)).rejects.toThrowError(/TRANSPORT_FAILED/)
  await expect(runPeerDelegate({ ...options, fetch: scripted([...exchange, { status: 500, body: {} }]) }, identity, 'p')).rejects.toThrowError(/TRANSPORT_FAILED/)
  await expect(runPeerFollowup({ ...options, fetch: scripted([...exchange, { raw: 'not json' }]) }, identity, runResult.sessionId, 'p')).rejects.toThrowError(/TRANSPORT_FAILED/)
})

it('rejects malformed operation readbacks with the transport reason', async () => {
  const root = await home()
  const identity = await identityOf(root)
  const options = { target, home: root, origin: target.endpoint.origin, timeoutMs: 5_000 }
  const malformed = [
    null, {}, { sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm', state: 'other' },
    { ...runResult, reply: 5 }, { ...runResult, endReason: null },
  ]
  for (const value of malformed) {
    await expect(runPeerDelegate({ ...options, fetch: scripted([...exchange, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value } } }]) }, identity, 'p'))
      .rejects.toThrowError(/TRANSPORT_FAILED/)
  }
  for (const value of [null, {}, { sessions: 'x' }, { sessions: [{ sessionId: 5 }] }, { sessions: [{ sessionId: 's', createdAt: 'x', lastActivityAt: 'y', label: 'l', state: 'busy' }] }]) {
    await expect(runPeerSessions({ ...options, fetch: scripted([...exchange, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value } } }]) }, identity))
      .rejects.toThrowError(/TRANSPORT_FAILED/)
  }
})
