/** Peer outbox behavior: ledger durability, settlement polling, and inbox delivery. */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { peerInstanceId } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerRunResult } from '@deepseek-ai/dsh-peer-protocol'
import { peerIdentityKeyPath, writePeerTargets } from '@deepseek-ai/dsh-peer-client'
import PeerOutbox from '../src/index.ts'
import { outboxDeliveryMessage } from '../src/envelope.ts'
import type { PeerOutboxEntry } from '../src/types.ts'

const TARGET_ID = peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666')

/** One scripted settlement-read target with a token-exchange prefix. */
class ScriptedTarget {
  /** Queued result readbacks, shifted per read. */
  results: PeerRunResult[] = []
  /** Wire-error reason answered instead of a queued result. */
  wireError: { reason: string } | undefined
  /** Transport failures left to answer before succeeding. */
  failTransportLeft = 0
  /** Delay applied to each settlement read, in milliseconds. */
  readDelayMs = 0
  /** Captured result requests. */
  readonly reads: Array<{ sessionId: string; messageId: string }> = []
  private readonly server: Server

  constructor() {
    this.server = createServer((req, response) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => { chunks.push(chunk as Buffer) })
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { rpcId?: string; payload?: { args?: { request?: { sessionId?: string; messageId?: string; proof?: unknown } } } }
        if (req.url === '/auth/challenge') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ id: 'cha', payload: 'c2lnbg', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
          return
        }
        if (req.url === '/auth/token') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
          return
        }
        const request = body.payload?.args?.request ?? {}
        this.reads.push({ sessionId: request.sessionId ?? '', messageId: request.messageId ?? '' })
        if (this.readDelayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.readDelayMs)
        const send = (value: unknown, ok = true): void => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(ok
            ? { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }
            : { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'peer-failed', details: { reason: this.wireError?.reason }, message: `peer: ${String(this.wireError?.reason)}` } } }))
        }
        if (this.failTransportLeft > 0) {
          this.failTransportLeft -= 1
          response.statusCode = 503
          response.setHeader('content-type', 'text/plain')
          response.end('unreachable')
          return
        }
        if (this.wireError !== undefined) { send(undefined, false); return }
        send(this.results.shift() ?? { sessionId: request.sessionId, messageId: request.messageId, state: 'running' })
      })
    })
  }

  /** Start listening and return the reachable origin. */
  async start(): Promise<string> {
    await new Promise<void>((resolve) => { this.server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('scripted target: no listen address')
    return `http://127.0.0.1:${String(address.port)}`
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }
}

/** One scripted live agent over a real session. */
interface AgentScript {
  readonly session: Session
  followups: UserMessage[]
  maintenance?: { busyOnce?: boolean }
  runMaintenanceError?: unknown
  running?: boolean
}

/** Minimal live-agent stub over a real session. */
function fakeAgent(script: AgentScript): Agent {
  const signal = new AbortController().signal
  let busy = script.maintenance?.busyOnce === true
  const agent = {
    id: script.session.id,
    session: script.session,
    status: script.running === true ? 'running' : 'idle' as 'idle' | 'running',
    whenIdle: async (): Promise<void> => {
      ;(agent as unknown as { status: string }).status = 'idle'
    },
    followup: (message: UserMessage) => {
      script.followups.push(message)
    },
    runMaintenance: <T>(task: (agentSignal: AbortSignal) => Promise<T>): Promise<T> => {
      if (script.runMaintenanceError !== undefined) throw script.runMaintenanceError
      if (busy) {
        busy = false
        throw new Error('agent already has active work')
      }
      return task(signal)
    },
  }
  return agent as unknown as Agent
}

/** The full outbox harness: real storage, real sessions, scripted agents and target. */
async function harness(options: { pollIntervalMs?: number; maxResultChars?: number; target?: boolean } = {}): Promise<{
  ctx: Context
  outbox: PeerOutbox
  home: string
  target: ScriptedTarget
  script: AgentScript
  flushSpy: ReturnType<typeof vi.spyOn>
  track: (overrides?: Partial<Parameters<PeerOutbox['track']>[0]>) => Promise<PeerOutboxEntry>
}> {
  const home = await mkdtemp(join(tmpdir(), 'peer-outbox-'))
  const target = new ScriptedTarget()
  const origin = await target.start()
  if (options.target !== false) {
    await writePeerTargets(home, [{
      targetInstanceId: TARGET_ID,
      displayName: 'Build workstation',
      endpoint: { origin },
      transport: { kind: 'direct' },
      grantName: `peer-${TARGET_ID}`,
      grantId: 'grant-1',
      status: 'active',
      addedAt: '2026-01-01T00:00:00.000Z',
    }])
  }
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const script: AgentScript = {
    session: ctx.sessions.create(SessionId('owner-session')),
    followups: [],
  }
  ctx.provide('agents', { get: (id: string) => id === script.session.id ? fakeAgent(script) : undefined } as never)
  const flushSpy = vi.spyOn(ctx.sessions, 'flush')
  await ctx.plugin(PeerOutbox, {
    dshHome: home,
    pollIntervalMs: options.pollIntervalMs ?? 100,
    ...(options.maxResultChars !== undefined ? { maxResultChars: options.maxResultChars } : {}),
  })
  const outbox = ctx.peerOutbox
  if (outbox === undefined) throw new Error('peer outbox service did not start')
  return {
    ctx, outbox, home, target, script, flushSpy,
    track: async (overrides = {}) => outbox.track({
      targetInstanceId: TARGET_ID,
      targetDisplayName: 'Build workstation',
      peerSessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef',
      messageId: 'm1',
      ownerSessionId: script.session.id,
      label: 'summarize the build',
      ...overrides,
    }),
  }
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** Remove one home, retrying once while a late backend flush releases it. */
async function removeHome(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    await new Promise(resolve => setTimeout(resolve, 150))
    await rm(path, { recursive: true, force: true })
  }
}

/** Await one poll-driven assertion. */
function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000, interval: 20 })
}

it('delivers one settled reply into the live owner session and closes the entry', async () => {
  const rig = await harness()
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'done: audit', endReason: 'completed' }]
  const entry = await rig.track()
  await waitFor(() => {
    const stored = rig.outbox.list().find(candidate => candidate.id === entry.id)
    expect(stored).toMatchObject({ state: 'settled', reply: 'done: audit', endReason: 'completed' })
  })
  expect(rig.script.followups).toHaveLength(1)
  const delivered = rig.script.followups[0]!
  const text = delivered.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n')
  expect(text).toContain('Delegated task on Build workstation (' + TARGET_ID + ') settled: completed.')
  expect(text).toContain('done: audit')
  expect(delivered.source).toMatchObject({ kind: 'plugin', plugin: 'peer', entryId: entry.id })
  expect((rig.flushSpy as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0)
})

it('narrates non-completed endings, empty replies, and truncation', async () => {
  const first = await harness({ maxResultChars: 10 })
  cleanups.push(() => first.ctx.fiber.dispose(), () => first.target.stop(), () => removeHome(first.home))
  first.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', endReason: 'aborted' }]
  await first.track()
  await waitFor(() => {
    expect(first.script.followups).toHaveLength(1)
  })
  const ended = first.script.followups[0]!
  const endedText = ended.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n')
  expect(endedText).toContain('settled: ended aborted.')
  expect(endedText).toContain('(the settled turn produced no reply text)')
  expect(ended.source).toMatchObject({ endReason: 'aborted' })

  const second = await harness({ maxResultChars: 10 })
  cleanups.push(() => second.ctx.fiber.dispose(), () => second.target.stop(), () => removeHome(second.home))
  second.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: '0123456789abcdef', endReason: 'completed' }]
  await second.track()
  await waitFor(() => {
    expect(second.script.followups).toHaveLength(1)
  })
  const clipped = second.script.followups[0]!.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n')
  expect(clipped).toContain('0123456789')
  expect(clipped).toContain('… [truncated: 6 more characters]')
})

it('keeps watching while the turn is still running', async () => {
  const rig = await harness()
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'running' }]
  const entry = await rig.track()
  await waitFor(() => {
    expect(rig.target.reads.length).toBeGreaterThanOrEqual(2)
  })
  expect(rig.outbox.list().find(candidate => candidate.id === entry.id)).toMatchObject({ state: 'watching' })
  expect(rig.script.followups).toHaveLength(0)
})

it('re-probes one transient transport fault and fails after the second', async () => {
  const rig = await harness()
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.failTransportLeft = 1
  rig.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'after blip', endReason: 'completed' }]
  const entry = await rig.track()
  await waitFor(() => {
    expect(rig.outbox.list().find(candidate => candidate.id === entry.id)).toMatchObject({ state: 'settled', reply: 'after blip' })
  })

  const harsh = await harness()
  cleanups.push(() => harsh.ctx.fiber.dispose(), () => harsh.target.stop(), () => removeHome(harsh.home))
  harsh.target.failTransportLeft = 10
  const failed = await harsh.track()
  await waitFor(() => {
    const stored = harsh.outbox.list().find(candidate => candidate.id === failed.id)
    expect(stored).toMatchObject({ state: 'failed', failureReason: 'TARGET_UNREACHABLE' })
    expect(stored?.failureDetail).toContain('TRANSPORT_FAILED')
  })
  expect(harsh.script.followups).toHaveLength(0)
})

it('fails entries for dropped sessions, closed peer surfaces, and missing target records', async () => {
  const rig = await harness()
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.wireError = { reason: 'SESSION_NOT_FOUND' }
  const dropped = await rig.track({ messageId: 'drop' })
  await waitFor(() => {
    expect(rig.outbox.list().find(candidate => candidate.id === dropped.id)).toMatchObject({ state: 'failed', failureReason: 'SESSION_DROPPED' })
  })

  const denied = await harness()
  cleanups.push(() => denied.ctx.fiber.dispose(), () => denied.target.stop(), () => removeHome(denied.home))
  denied.target.wireError = { reason: 'SURFACE_DENIED' }
  const surfaced = await denied.track({ messageId: 'deny' })
  await waitFor(() => {
    expect(denied.outbox.list().find(candidate => candidate.id === surfaced.id)).toMatchObject({ state: 'failed', failureReason: 'SESSION_DROPPED' })
  })

  const orphan = await harness({ target: false })
  cleanups.push(() => orphan.ctx.fiber.dispose(), () => orphan.target.stop(), () => removeHome(orphan.home))
  const lost = await orphan.track({ messageId: 'gone' })
  await waitFor(() => {
    expect(orphan.outbox.list().find(candidate => candidate.id === lost.id)).toMatchObject({ state: 'failed', failureReason: 'TARGET_RECORD_NOT_FOUND' })
  })
})

it('maps closed peer reasons and corrupt identities onto read failures', async () => {
  const rig = await harness()
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.wireError = { reason: 'RECORD_NOT_FOUND' }
  const refused = await rig.track({ messageId: 'refuse' })
  await waitFor(() => {
    expect(rig.outbox.list().find(candidate => candidate.id === refused.id)).toMatchObject({ state: 'failed', failureReason: 'READ_FAILED' })
  })

  const corrupt = await harness()
  cleanups.push(() => corrupt.ctx.fiber.dispose(), () => corrupt.target.stop(), () => removeHome(corrupt.home))
  await corrupt.track({ messageId: 'm1' })
  await waitFor(() => {
    expect(corrupt.target.reads.length).toBeGreaterThanOrEqual(1)
  })
  await writeFile(peerIdentityKeyPath(corrupt.home), 'not a pem', 'utf8')
  const broken = await corrupt.track({ messageId: 'm2' })
  await waitFor(() => {
    expect(corrupt.outbox.list().find(candidate => candidate.id === broken.id)).toMatchObject({ state: 'failed', failureReason: 'READ_FAILED' })
  })
})

it('retains the reply when the owner session is no longer live', async () => {
  const rig = await harness()
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'orphaned reply', endReason: 'completed' }]
  const entry = await rig.track({ ownerSessionId: 'closed-session' })
  await waitFor(() => {
    expect(rig.outbox.list().find(candidate => candidate.id === entry.id)).toMatchObject({ state: 'failed', failureReason: 'OWNER_SESSION_NOT_LIVE', reply: 'orphaned reply' })
  })
  expect(rig.script.followups).toHaveLength(0)
})

it('waits for a busy owner agent before delivering, and fails closed when maintenance is unavailable', async () => {
  const rig = await harness()
  rig.script.maintenance = { busyOnce: true }
  rig.script.running = true
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'after idle', endReason: 'completed' }]
  const entry = await rig.track()
  await waitFor(() => {
    expect(rig.script.followups).toHaveLength(1)
    expect(rig.outbox.list().find(candidate => candidate.id === entry.id)).toMatchObject({ state: 'settled' })
  })

  const broken = await harness()
  broken.script.runMaintenanceError = 'maintenance refused'
  cleanups.push(() => broken.ctx.fiber.dispose(), () => broken.target.stop(), () => removeHome(broken.home))
  broken.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'never delivered', endReason: 'completed' }]
  const stuck = await broken.track()
  await waitFor(() => {
    const stored = broken.outbox.list().find(candidate => candidate.id === stuck.id)
    expect(stored).toMatchObject({ state: 'failed', failureReason: 'READ_FAILED' })
    expect(stored?.failureDetail).toContain('delivery failed')
  })

  const errored = await harness()
  errored.script.runMaintenanceError = new Error('maintenance refused')
  cleanups.push(() => errored.ctx.fiber.dispose(), () => errored.target.stop(), () => removeHome(errored.home))
  errored.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'held back', endReason: 'completed' }]
  const held = await errored.track()
  await waitFor(() => {
    expect(errored.outbox.list().find(candidate => candidate.id === held.id)?.failureDetail).toBe('delivery failed: maintenance refused')
  })
})

it('delivers same-session entries in submission order and defers late tracks to the next cycle', async () => {
  const rig = await harness({ pollIntervalMs: 500 })
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.readDelayMs = 150
  rig.target.results = [
    { sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'first', endReason: 'completed' },
    { sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm2', state: 'settled', reply: 'second', endReason: 'completed' },
  ]
  await rig.track({ messageId: 'm1' })
  await waitFor(() => {
    expect(rig.target.reads.length).toBeGreaterThanOrEqual(1)
  })
  await rig.track({ messageId: 'm2' })
  await waitFor(() => {
    expect(rig.script.followups).toHaveLength(2)
  })
  const replies = rig.script.followups.flatMap(message => message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text))
  expect(replies.find(text => text.includes('first'))).toBeDefined()
  expect(replies.find(text => text.includes('second'))).toBeDefined()
  expect(replies.findIndex(text => text.includes('first'))).toBeLessThan(replies.findIndex(text => text.includes('second')))
  expect(rig.outbox.list()).toHaveLength(2)
})

it('resumes watching after a restart from the durable ledger', async () => {
  const rig = await harness()
  rig.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'running' }]
  const entry = await rig.track({ label: 'x'.repeat(100) })
  await waitFor(() => {
    expect(rig.target.reads.length).toBeGreaterThanOrEqual(1)
  })
  expect(rig.outbox.list().find(candidate => candidate.id === entry.id)?.label).toBe('x'.repeat(64))
  const { home, target } = rig
  await rig.ctx.fiber.dispose()

  const ctx2 = new Context()
  await ctx2.plugin(SessionStore)
  await ctx2.plugin(Storage)
  await ctx2.plugin(StorageJson, { root: join(home, 'storages') })
  await ctx2.plugin(StorageDomain, { backend: 'json' })
  const script: AgentScript = { session: ctx2.sessions.create(SessionId('owner-session')), followups: [] }
  ctx2.provide('agents', { get: (id: string) => id === script.session.id ? fakeAgent(script) : undefined } as never)
  await ctx2.plugin(PeerOutbox, { dshHome: home, pollIntervalMs: 100 })
  cleanups.push(() => ctx2.fiber.dispose(), () => target.stop(), () => removeHome(home))
  target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'after restart', endReason: 'completed' }]
  await vi.waitFor(() => {
    expect(script.followups).toHaveLength(1)
    expect(ctx2.peerOutbox?.list().find(candidate => candidate.id === entry.id)).toMatchObject({ state: 'settled', reply: 'after restart' })
  }, { timeout: 10_000, interval: 20 })
})

it('prunes terminal entries beyond the retention bound', async () => {
  const rig = await harness()
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.wireError = { reason: 'SESSION_NOT_FOUND' }
  for (let index = 0; index < 202; index += 1) {
    await rig.track({ messageId: `m${String(index)}` })
  }
  await waitFor(() => {
    expect(rig.outbox.list().every(row => row.state === 'failed')).toBe(true)
    expect(rig.outbox.list()).toHaveLength(200)
  })
})

it('refuses reads before Service.init and settles turns that omit an end reason', async () => {
  const constructed = new PeerOutbox(new Context(), { dshHome: '/tmp', pollIntervalMs: 100, maxResultChars: 10 })
  expect(() => constructed.list()).toThrow(/peer-outbox storage is not ready/)
  await (constructed as unknown as { ctx: { fiber: { dispose(): Promise<void> } } }).ctx.fiber.dispose()

  const rig = await harness()
  cleanups.push(() => rig.ctx.fiber.dispose(), () => rig.target.stop(), () => removeHome(rig.home))
  rig.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'no reason given' }]
  const entry = await rig.track()
  await waitFor(() => {
    expect(rig.outbox.list().find(candidate => candidate.id === entry.id)).toMatchObject({ state: 'settled', reply: 'no reason given' })
  })
  const deliveredSource = rig.script.followups[0]!.source as Record<string, unknown>
  expect(deliveredSource).not.toHaveProperty('endReason')

  const cold = await harness()
  cleanups.push(() => cold.ctx.fiber.dispose(), () => cold.target.stop(), () => removeHome(cold.home))
  cold.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'settled', reply: 'quiet orphan' }]
  const orphaned = await cold.track({ ownerSessionId: 'closed-session' })
  await waitFor(() => {
    expect(cold.outbox.list().find(candidate => candidate.id === orphaned.id)).toMatchObject({ state: 'failed', failureReason: 'OWNER_SESSION_NOT_LIVE' })
  })
})

it('orders same-moment entries by id through the clock seam', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-outbox-order-'))
  const target = new ScriptedTarget()
  const origin = await target.start()
  await writePeerTargets(home, [{
    targetInstanceId: TARGET_ID,
    displayName: 'Build workstation',
    endpoint: { origin },
    transport: { kind: 'direct' },
    grantName: `peer-${TARGET_ID}`,
    grantId: 'grant-1',
    status: 'active',
    addedAt: '2026-01-01T00:00:00.000Z',
  }])
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  class FrozenClock extends PeerOutbox {
    protected override now(): number { return 12345 }
  }
  ctx.provide('agents', { get: () => undefined } as never)
  await ctx.plugin(FrozenClock, { dshHome: home, pollIntervalMs: 60_000 })
  const outbox = ctx.get('peerOutbox')
  await outbox!.track({
    targetInstanceId: TARGET_ID, targetDisplayName: 'Build workstation',
    peerSessionId: 'peer-b', messageId: 'm1', ownerSessionId: 'owner', label: 'b',
  })
  await outbox!.track({
    targetInstanceId: TARGET_ID, targetDisplayName: 'Build workstation',
    peerSessionId: 'peer-a', messageId: 'm2', ownerSessionId: 'owner', label: 'a',
  })
  const ids = outbox!.list().map(row => row.id)
  expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
  expect(outbox!.list().every(row => row.submittedAt === 12345)).toBe(true)
  expect(outbox!.list()).toHaveLength(2)
  await ctx.fiber.dispose()
  await target.stop()
  await removeHome(home)
})

it('boots with loader-resolved defaults and renders envelopes directly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peer-outbox-defaults-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(home, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('agents', { get: () => undefined } as never)
  await ctx.plugin(PeerOutbox, { dshHome: home })
  cleanups.push(() => ctx.fiber.dispose(), () => removeHome(home))
  expect(ctx.get('peerOutbox')?.list()).toEqual([])

  const base = {
    id: 'entry-1', targetInstanceId: TARGET_ID, targetDisplayName: 'Build workstation',
    peerSessionId: 'peer-0', messageId: 'm1', ownerSessionId: 'owner', label: 'l',
    state: 'settled' as const, submittedAt: 0,
  }
  const withReply = outboxDeliveryMessage({ ...base }, 'hello')
  const text = withReply.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n')
  expect(text).toContain('settled: completed.')
  expect(text).toContain('hello')
  expect(withReply.source).not.toHaveProperty('endReason')
  const quiet = outboxDeliveryMessage({ ...base, endReason: 'aborted', reply: '' }, '')
  const quietText = quiet.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n')
  expect(quietText).toContain('settled: ended aborted.')
  expect(quietText).toContain('(the settled turn produced no reply text)')
})

it('stops polling with its context, including mid-cycle', async () => {
  const rig = await harness()
  rig.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'running' }]
  await rig.track()
  await waitFor(() => {
    expect(rig.target.reads.length).toBeGreaterThanOrEqual(1)
  })
  const reads = rig.target.reads.length
  expect(rig.ctx.get('peerOutbox')).toBeDefined()
  await rig.ctx.fiber.dispose()
  cleanups.push(() => rig.target.stop(), () => removeHome(rig.home))
  expect(rig.ctx.get('peerOutbox')).toBeUndefined()
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(rig.target.reads.length).toBe(reads)

  const midcycle = await harness()
  midcycle.target.readDelayMs = 120
  midcycle.target.results = [{ sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', messageId: 'm1', state: 'running' }]
  await midcycle.track()
  await waitFor(() => {
    expect(midcycle.target.reads.length).toBeGreaterThanOrEqual(1)
  })
  await midcycle.ctx.fiber.dispose()
  cleanups.push(() => midcycle.target.stop(), () => removeHome(midcycle.home))
  const midReads = midcycle.target.reads.length
  await new Promise(resolve => setTimeout(resolve, 400))
  expect(midcycle.target.reads.length).toBe(midReads)
})
