/** Peer event stream: stream tokens, the nonce ledger, and the SSE pump over live session events. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { PEER_NONCE_TTL_MS, PEER_STREAM_TOKEN_TTL_MS } from '@deepseek-ai/dsh-peer-protocol'
import { encodePeerEventFrame, PeerNonceLedger, PeerStreamTokens, runPeerEventStream } from '../src/events.ts'
import { writePeerSessions } from '../src/session-registry.ts'

const directories: string[] = []
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'peer-events-'))
  directories.push(path)
  return path
}

/** One peer-owned session registry entry persisted for the stream filter. */
async function seedSession(root: string, instanceId: string, sessionId = 'peer-01234567-89ab-cdef-0123-456789abcdef'): Promise<void> {
  const existing = await import('../src/session-registry.ts').then(module => module.readPeerSessions(root))
  await writePeerSessions(root, [...existing, {
    sessionId, peerInstanceId: instanceId, createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
    cwd: root, label: 'seed',
  }])
}

it('mints single-use stream tokens that expire and evict beyond the cap', () => {
  const tokens = new PeerStreamTokens()
  const now = 1_000_000
  const first = tokens.mint('aaaaaaaa-1111-4222-8333-444455556666', now)
  expect(first.heartbeatMs).toBeGreaterThan(0)
  expect(tokens.redeem(first.streamToken, now)).toBe('aaaaaaaa-1111-4222-8333-444455556666')
  expect(tokens.redeem(first.streamToken, now)).toBeUndefined()
  expect(tokens.redeem('unknown', now)).toBeUndefined()
  const expiring = tokens.mint('aaaaaaaa-1111-4222-8333-444455556666', now)
  expect(tokens.redeem(expiring.streamToken, now + PEER_STREAM_TOKEN_TTL_MS + 1)).toBeUndefined()
  const stale = tokens.mint('eeeeeeee-1111-4222-8333-444455556666', now)
  const later = now + PEER_STREAM_TOKEN_TTL_MS + 1
  void stale
  const minted: string[] = []
  for (let index = 0; index < 257; index += 1) minted.push(tokens.mint('bbbbbbbb-1111-4222-8333-444455556666', index === 0 ? later : now).streamToken)
  expect(tokens.redeem(minted[0]!, now)).toBeUndefined()
  expect(tokens.redeem(minted[256]!, now)).toBe('bbbbbbbb-1111-4222-8333-444455556666')
})

it('consumes proof nonces once, prunes past the retention horizon, and bounds the bucket', () => {
  const ledger = new PeerNonceLedger()
  const now = 1_000_000
  const peer = 'cccccccc-1111-4222-8333-444455556666'
  expect(ledger.consume(peer, 'n1', now)).toBe(true)
  expect(ledger.consume(peer, 'n1', now)).toBe(false)
  expect(ledger.consume(peer, 'n1', now + PEER_NONCE_TTL_MS + 1)).toBe(true)
  for (let index = 0; index < 257; index += 1) ledger.consume(peer, `bulk-${String(index)}`, now)
  expect(ledger.consume(peer, 'bulk-0', now + PEER_NONCE_TTL_MS + 1)).toBe(true)
})

it('encodes settlement frames as data lines', () => {
  expect(encodePeerEventFrame({ kind: 'settled', sessionId: 'peer-1' })).toBe('data: {"kind":"settled","sessionId":"peer-1"}\n\n')
})

/** Emit one session event into the context bus. */
function emit(ctx: Context, sessionId: string, event: SessionEvent): void {
  ctx.emit('session/event', { id: sessionId } as Session, event)
}

/** One turn/end event as the settlement signal. */
function turnEnd(): SessionEvent {
  return { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } } as SessionEvent
}

/** The pump reads the registry before it listens; a loaded runner outruns any fixed sleep. */
const LISTENING = { timeout: 10_000, interval: 5 }

/** One non-settlement event for filter coverage. */
function turnStart(): SessionEvent {
  return { type: 'turn/start', data: { turn: 't1' } } as SessionEvent
}

it('streams settlement frames for owned sessions with heartbeats until aborted', async () => {
  const root = await home()
  const instanceId = 'dddddddd-1111-4222-8333-444455556666'
  const sessionId = 'peer-01234567-89ab-cdef-0123-456789abcdef'
  await seedSession(root, instanceId, sessionId)
  await seedSession(root, 'eeeeeeee-1111-4222-8333-444455556666', 'peer-99999999-9999-4999-8999-999999999999')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const written: string[] = []
  const controller = new AbortController()
  const done = runPeerEventStream({
    ctx, home: root, instanceId, heartbeatMs: 5,
    write: (chunk) => { written.push(chunk) },
    signal: controller.signal,
  })
  await vi.waitFor(() => { expect(written).toContain(': peer\n\n') }, LISTENING)
  emit(ctx, sessionId, turnStart())
  emit(ctx, 'peer-other-session', turnEnd())
  emit(ctx, sessionId, turnEnd())
  controller.abort()
  await expect(done).resolves.toBe('closed')
  expect(written).toContain(encodePeerEventFrame({ kind: 'settled', sessionId }))
  expect(written.some(chunk => chunk === ': peer\n\n')).toBe(true)
  expect(written.filter(chunk => chunk.startsWith('data: '))).toHaveLength(1)
})

it('guards sends after a broken write and after an external abort', async () => {
  const root = await home()
  const instanceId = 'dddddddd-1111-4222-8333-444455556666'
  const sessionId = 'peer-01234567-89ab-cdef-0123-456789abcdef'
  await seedSession(root, instanceId, sessionId)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const attempts: string[] = []
  const controller = new AbortController()
  let broken = false
  const done = runPeerEventStream({
    ctx, home: root, instanceId, heartbeatMs: 60_000,
    write: (chunk) => {
      attempts.push(chunk)
      if (broken) throw new Error('client gone')
    },
    signal: controller.signal,
  })
  await vi.waitFor(() => {
    emit(ctx, sessionId, turnEnd())
    expect(attempts).toHaveLength(1)
  }, LISTENING)
  broken = true
  // The first broken send aborts the pump; a second synchronous event hits the guard.
  emit(ctx, sessionId, turnEnd())
  emit(ctx, sessionId, turnEnd())
  await expect(done).resolves.toBe('write-failed')
  expect(attempts).toHaveLength(2)

  const second = new AbortController()
  const seen: string[] = []
  const pump = runPeerEventStream({
    ctx, home: root, instanceId, heartbeatMs: 60_000,
    write: (chunk) => { seen.push(chunk) },
    signal: second.signal,
  })
  await vi.waitFor(() => {
    emit(ctx, sessionId, turnEnd())
    expect(seen).toHaveLength(1)
  }, LISTENING)
  second.abort()
  // A queued event between the abort and the pump's cleanup still reaches the
  // sink; the send's try keeps that late write contained.
  emit(ctx, sessionId, turnEnd())
  await expect(pump).resolves.toBe('closed')
  expect(seen).toHaveLength(2)
})

it('stops writing once the registry drops the session, and reports write failures', async () => {
  const root = await home()
  const instanceId = 'dddddddd-1111-4222-8333-444455556666'
  const sessionId = 'peer-01234567-89ab-cdef-0123-456789abcdef'
  await seedSession(root, instanceId, sessionId)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const written: string[] = []
  const controller = new AbortController()
  let broken = false
  const done = runPeerEventStream({
    ctx, home: root, instanceId, heartbeatMs: 5,
    write: (chunk) => {
      if (broken) throw new Error('client gone')
      written.push(chunk)
    },
    signal: controller.signal,
  })
  const frames = (): number => written.filter(chunk => chunk.startsWith('data: ')).length
  await vi.waitFor(() => { expect(written).toContain(': peer\n\n') }, LISTENING)
  emit(ctx, sessionId, turnEnd())
  expect(frames()).toBe(1)
  // The heartbeat refresh picks up the registry rewrite: probed events stop being delivered.
  const registry = await import('../src/session-registry.ts')
  await registry.writePeerSessions(root, [])
  await vi.waitFor(() => {
    const before = written.length
    emit(ctx, sessionId, turnEnd())
    expect(written).toHaveLength(before)
  }, LISTENING)
  // Later events stay unsent.
  const settled = frames()
  emit(ctx, sessionId, turnEnd())
  expect(frames()).toBe(settled)
  broken = true
  await expect(done).resolves.toBe('write-failed')
})
