/** Settlement-read Remote over a scripted agent registry and optional persistence. */

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

/** One recorded session event in the scripted log. */
interface LoggedEvent {
  type: string
  seq: number
  data: unknown
}

/** A synchronous agent registry whose followups append a full settlement immediately. */
class Registry extends Service {
  /** Session logs by session id. */
  readonly logs = new Map<string, LoggedEvent[]>()
  /** When set, followups stop after the claim so the turn stays outstanding. */
  hold = false

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  get(id: string) {
    return this.logs.has(id)
      ? {
        status: 'idle' as const,
        whenIdle: () => Promise.resolve(),
        session: {
          id,
          events: this.logs.get(id),
          eventsFrom: (from: number) => (this.logs.get(id) as LoggedEvent[]).filter(event => event.seq >= from),
        },
        followup: (message: { id: string; content: Array<{ type: string; text?: string }> }) => {
          const events = this.logs.get(id) as LoggedEvent[]
          events.push({ type: 'user/message', seq: events.length, data: message })
          if (this.hold) return
          const turn = 1 + events.filter(event => event.type === 'turn/end').length
          const prompt = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
          events.push({ type: 'assistant/message', seq: events.length, data: { turn, message: { content: [{ type: 'text', text: `done: ${prompt}` }] } } })
          events.push({ type: 'turn/end', seq: events.length, data: { turn, reason: { kind: 'completed' } } })
        },
      }
      : undefined
  }

  async create(options: { sessionId: string; setup: (ctx: Context) => Promise<void> }) {
    await options.setup({ agent: { session: { id: options.sessionId } } } as unknown as Context)
    this.logs.set(options.sessionId, [])
    return { agent: this.get(options.sessionId) }
  }

  async closeIfIdle(id: string) {
    return this.logs.delete(id) ? 'closed' : 'not-found'
  }
}

/** A scripted persistence service answering inspections from recorded snapshots. */
class Persistence extends Service {
  /** Recorded inspections by session id. */
  readonly snapshots = new Map<string, { meta: unknown; events: LoggedEvent[] }>()

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  async inspect(id: string) {
    const snapshot = this.snapshots.get(id)
    if (snapshot === undefined) throw new Error('not persisted')
    return snapshot
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

/** Mount the host with the scripted registry and one pinned active caller record. */
async function rig(surface: { delegate: boolean; message: boolean; list: boolean } = { delegate: true, message: true, list: true }) {
  const root = await mkdtemp(join(tmpdir(), 'peer-result-'))
  directories.push(root)
  await ensureInstanceIdentity(root)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Registry)
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
  return { root, ctx, host: ctx.peerHost, key, registry: ctx.get('agents') as unknown as Registry }
}

/** Mint one valid request proof for the caller. */
function proofFor(key: ReturnType<typeof identityKey>): PeerRequestProof {
  const timestamp = Date.now()
  return { instanceId: caller, timestamp, signature: key.sign(peerRequestMessage(caller, timestamp)) }
}

it('reads one settled turn through the live agent without a new prompt', async () => {
  const { host, key } = await rig()
  const delegated = await host.delegate({ proof: proofFor(key), prompt: 'summarize' })
  const read = await host.result({ proof: proofFor(key), sessionId: delegated.sessionId, messageId: delegated.messageId })
  expect(read).toMatchObject({ sessionId: delegated.sessionId, messageId: delegated.messageId, state: 'settled', reply: 'done: summarize', endReason: 'completed' })
})

it('reads one outstanding turn as running', async () => {
  const { host, key, registry } = await rig()
  registry.hold = true
  const delegated = await host.delegate({ proof: proofFor(key), prompt: 'slow' })
  const read = await host.result({ proof: proofFor(key), sessionId: delegated.sessionId, messageId: delegated.messageId })
  expect(read).toMatchObject({ state: 'running' })
  expect(read.reply).toBeUndefined()
})

it('reads one settled turn from persisted events after the agent went cold', async () => {
  const { ctx, host, key, registry } = await rig()
  const delegated = await host.delegate({ proof: proofFor(key), prompt: 'cold read' })
  await ctx.plugin(Persistence)
  const persistence = ctx.get('sessionPersistence') as unknown as Persistence
  persistence.snapshots.set(delegated.sessionId, { meta: {}, events: [...(registry.logs.get(delegated.sessionId) as LoggedEvent[])] })
  await registry.closeIfIdle(delegated.sessionId)
  const read = await host.result({ proof: proofFor(key), sessionId: delegated.sessionId, messageId: delegated.messageId })
  expect(read).toMatchObject({ state: 'settled', reply: 'done: cold read' })
})

it('rejects foreign sessions, unknown ids, and absent persistence', async () => {
  const { root, host, key } = await rig()
  const delegated = await host.delegate({ proof: proofFor(key), prompt: 'p' })
  await expect(host.result({ proof: proofFor(key), sessionId: 'peer-00000000-0000-4000-8000-000000000000', messageId: delegated.messageId }))
    .rejects.toThrowError(/SESSION_NOT_FOUND/)
  const sessions = await readPeerSessions(root)
  await writePeerSessions(root, sessions.map(entry => ({ ...entry, peerInstanceId: other })))
  await expect(host.result({ proof: proofFor(key), sessionId: delegated.sessionId, messageId: delegated.messageId }))
    .rejects.toThrowError(/SESSION_NOT_FOUND/)
})

it('rejects unknown claims and malformed requests', async () => {
  const { host, key } = await rig()
  const delegated = await host.delegate({ proof: proofFor(key), prompt: 'p' })
  await expect(host.result({ proof: proofFor(key), sessionId: delegated.sessionId, messageId: 'never-accepted' }))
    .rejects.toThrowError(/SESSION_NOT_FOUND/)
  await expect(host.result({ proof: proofFor(key), sessionId: 'not-a-peer-session', messageId: 'm' }))
    .rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.result({ proof: proofFor(key), sessionId: delegated.sessionId, messageId: '' }))
    .rejects.toThrowError(/INVALID_PAYLOAD/)
})

it('denies the read when the list surface is closed', async () => {
  const { host, key } = await rig({ delegate: true, message: true, list: false })
  const delegated = await host.delegate({ proof: proofFor(key), prompt: 'p' })
  await expect(host.result({ proof: proofFor(key), sessionId: delegated.sessionId, messageId: delegated.messageId }))
    .rejects.toThrowError(/SURFACE_DENIED/)
})
