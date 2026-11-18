/** Delegate, follow-up, and enumeration Remotes over a scripted agent registry. */

import { generateKeyPairSync, sign } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensureInstanceIdentity, peerInstanceId, peerRequestMessage } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerRecord, PeerRequestProof } from '@deepseek-ai/dsh-peer-protocol'
import PeerHost from '../src/index.ts'
import { readPeerSessions, writePeerSessions } from '../src/session-registry.ts'
import { writePeerStore } from '../src/store.ts'

const directories: string[] = []
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const caller = peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666')
const other = peerInstanceId('77777777-1111-4222-8333-444455556666')

/** A scripted agent registry whose followups settle through a real event log. */
class FakeAgentRegistry extends Service {
  /** Created entries by session id: the agent facet and its scripted behavior. */
  readonly entries = new Map<string, { status: 'idle' | 'running'; followup: (message: { id: string; content: Array<{ type: string; text?: string }> }) => void; whenIdle: () => Promise<void>; session: { id: string; seq: number; events: Array<{ type: string; seq: number; data: unknown }>; eventsFrom: (from: number) => Array<{ type: string; data: unknown }> } }>()
  /** Session-creation metas by session id, for asserting peer composition. */
  readonly metas = new Map<string, { cwd: string; origin?: string; agentProfile?: string }>()
  /** Delay before a delivered turn settles; raise it past a budget to keep turns running. */
  settleMs = 10
  closed: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  get(id: string) {
    return this.entries.get(id)
  }

  async create(options: {
    sessionId: string
    meta: { cwd: string; origin?: string; agentProfile?: string }
    setup: (ctx: Context) => Promise<void>
  }) {
    this.metas.set(options.sessionId, options.meta)
    const events: Array<{ type: string; seq: number; data: unknown }> = []
    const session = {
      id: options.sessionId,
      events,
      get seq() { return events.length },
      eventsFrom: (from: number) => events.filter(event => event.seq >= from),
    }
    let idle: Promise<void> = Promise.resolve()
    const entry = {
      status: 'idle' as 'idle' | 'running',
      session,
      whenIdle: () => idle,
      followup: (message: { id: string; content: Array<{ type: string; text?: string }> }) => {
        const prompt = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
        entry.status = 'running'
        idle = new Promise((resolve) => {
          setTimeout(() => {
            const turn = 1 + events.filter(event => event.type === 'turn/end').length
            events.push({ type: 'turn/start', seq: events.length, data: { turn } })
            events.push({ type: 'user/message', seq: events.length, data: message })
            events.push({ type: 'assistant/message', seq: events.length, data: { turn, step: 1, message: { content: [{ type: 'text', text: `done: ${prompt}` }] } } })
            events.push({ type: 'turn/end', seq: events.length, data: { turn, reason: { kind: 'completed' } } })
            entry.status = 'idle'
            resolve()
          }, this.settleMs)
        })
      },
    }
    this.entries.set(options.sessionId, entry)
    return { agent: entry }
  }

  async resume(options: { resumeSessionId: string }) {
    if (!this.entries.has(options.resumeSessionId)) throw new Error('no persisted session')
    return { agent: this.entries.get(options.resumeSessionId)! }
  }

  async closeIfIdle(id: string) {
    this.closed.push(id)
    return this.entries.delete(id) ? 'closed' : 'not-found'
  }
}

/** One throwaway P-256 signing identity for request proofs. */
function identityKey(): { publicKey: string; sign(payload: string): string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    sign: payload => sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  }
}

/** Mount the host with a scripted registry and one pinned active caller record.
 * @param surface - the caller's approved surface.
 */
async function rig(surface: { delegate: boolean; message: boolean; list: boolean } = { delegate: true, message: true, list: true }) {
  const root = await mkdtemp(join(tmpdir(), 'peer-delegate-'))
  directories.push(root)
  await ensureInstanceIdentity(root)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(FakeAgentRegistry)
  await ctx.plugin(PeerHost, { dshHome: root })
  const key = identityKey()
  const record: PeerRecord = {
    instanceId: caller,
    displayName: 'Laptop', platform: 'darwin', arch: 'arm64', version: '1.0.0-rc.3',
    surface, pairedVia: 'invitation', status: 'active',
    identityPublicKey: key.publicKey,
    firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
  }
  await writePeerStore(root, [record])
  return { root, ctx, host: ctx.peerHost, key, registry: ctx.get('agents') as unknown as FakeAgentRegistry }
}

/** Mint one valid request proof for the caller.
 * @param key - the caller's signing identity.
 */
function proofFor(key: ReturnType<typeof identityKey>): PeerRequestProof {
  const timestamp = Date.now()
  return { instanceId: caller, timestamp, signature: key.sign(peerRequestMessage(caller, timestamp)) }
}

it('delegates one session, settles its first turn, and records the entry', async () => {
  const { root, host, key, registry } = await rig()
  const result = await host.delegate({ proof: proofFor(key), prompt: 'summarize the tree' })
  expect(result.state).toBe('settled')
  expect(result.reply).toBe('done: summarize the tree')
  expect(result.endReason).toBe('completed')
  expect(result.sessionId).toMatch(/^peer-[0-9a-f-]{36}$/)
  expect(result.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const sessions = await readPeerSessions(root)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ peerInstanceId: caller, label: 'summarize the tree', cwd: join(root, 'peer-work', caller) })
  expect(registry.metas.get(result.sessionId)).toMatchObject({ cwd: join(root, 'peer-work', caller), origin: 'peer' })
})

it('resolves a relative working directory inside the peer root and rejects escapes', async () => {
  const { root, host, key, registry } = await rig()
  const nested = await host.delegate({ proof: proofFor(key), prompt: 'p', cwd: 'repo/src' })
  expect(registry.metas.get(nested.sessionId)!.cwd).toBe(join(root, 'peer-work', caller, 'repo', 'src'))
  await expect(host.delegate({ proof: proofFor(key), prompt: 'p', cwd: '../escape' })).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.delegate({ proof: proofFor(key), prompt: 'p', cwd: '/etc' })).rejects.toThrowError(/INVALID_PAYLOAD/)
})

it('reports running past the settlement budget and keeps the entry', async () => {
  const { root, host, key, registry } = await rig()
  registry.settleMs = 10_000
  const result = await host.delegate({ proof: proofFor(key), prompt: 'slow', timeoutMs: 30 })
  expect(result.state).toBe('running')
  expect(result.reply).toBeUndefined()
  expect(await readPeerSessions(root)).toHaveLength(1)
})

it('follows up one owned session and rejects foreign or unknown ids', async () => {
  const { root, host, key } = await rig()
  const first = await host.delegate({ proof: proofFor(key), prompt: 'first' })
  const second = await host.followup({ proof: proofFor(key), sessionId: first.sessionId, prompt: 'second' })
  expect(second.state).toBe('settled')
  expect(second.reply).toBe('done: second')
  await expect(host.followup({ proof: proofFor(key), sessionId: 'peer-00000000-0000-4000-8000-000000000000', prompt: 'x' }))
    .rejects.toThrowError(/SESSION_NOT_FOUND/)
  const sessions = await readPeerSessions(root)
  await writePeerSessions(root, sessions.map(entry => ({ ...entry, peerInstanceId: other })))
  await expect(host.followup({ proof: proofFor(key), sessionId: first.sessionId, prompt: 'x' })).rejects.toThrowError(/SESSION_NOT_FOUND/)
})

it("enumerates only the caller's sessions with derived live state", async () => {
  const { root, host, key, registry } = await rig()
  const first = await host.delegate({ proof: proofFor(key), prompt: 'first' })
  await host.delegate({ proof: proofFor(key), prompt: 'second' })
  const rewritten = (await readPeerSessions(root))
    .map((entry, index) => index === 0 ? { ...entry, peerInstanceId: other } : entry)
  await writePeerSessions(root, rewritten)
  registry.entries.get(first.sessionId)!.status = 'running'
  const listed = await host.sessions({ proof: proofFor(key) })
  expect(listed.sessions).toHaveLength(1)
  expect(listed.sessions[0]).toMatchObject({ label: 'second', state: 'idle' })
  registry.entries.clear()
  const cleared = await host.sessions({ proof: proofFor(key) })
  expect(cleared.sessions[0]).toMatchObject({ state: 'ended' })
})

it('denies surfaces, malformed requests, stale proofs, and removal cleanup', async () => {
  const { host, key } = await rig({ delegate: false, message: false, list: false })
  await expect(host.delegate({ proof: proofFor(key), prompt: 'p' })).rejects.toThrowError(/SURFACE_DENIED/)
  await expect(host.followup({ proof: proofFor(key), sessionId: 'peer-00000000-0000-4000-8000-000000000000', prompt: 'p' })).rejects.toThrowError(/SURFACE_DENIED/)
  await expect(host.sessions({ proof: proofFor(key) })).rejects.toThrowError(/SURFACE_DENIED/)
  const open = await rig()
  await expect(open.host.delegate({ proof: { ...proofFor(open.key), signature: 'forged' }, prompt: 'p' })).rejects.toThrowError(/INVALID_PROOF/)
  const stale = proofFor(open.key)
  await expect(open.host.delegate({ proof: { ...stale, timestamp: stale.timestamp - 200_000 }, prompt: 'p' })).rejects.toThrowError(/INVALID_PROOF/)
  await expect(open.host.delegate({ proof: proofFor(open.key), prompt: '' })).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(open.host.delegate({ proof: proofFor(open.key), prompt: 'p', timeoutMs: 900_001 })).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(open.host.delegate(null as never)).rejects.toThrowError(/INVALID_PAYLOAD/)
  const settled = await open.host.delegate({ proof: proofFor(open.key), prompt: 'keep' })
  await open.host.removePeer(caller)
  expect(await readPeerSessions(open.root)).toEqual([])
  expect(open.registry.closed).toEqual([settled.sessionId])
})
