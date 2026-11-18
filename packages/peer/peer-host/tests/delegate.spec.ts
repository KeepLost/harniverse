/** Delegate, follow-up, and enumeration Remotes over a scripted agent registry. */

import { generateKeyPairSync, sign } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensureInstanceIdentity, peerInstanceId, peerRequestMessage } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerRecord, PeerRequestProof } from '@deepseek-ai/dsh-peer-protocol'
import PeerHost from '../src/index.ts'
import { readPeerSessions, writePeerSessions } from '../src/session-registry.ts'
import { readPeerStore, writePeerStore } from '../src/store.ts'

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
  /** Options observed at creation, for asserting agent composition. */
  readonly createOptions: Array<{
    meta: { cwd: string; origin?: string; agentProfile?: string }
    agentOptions?: { provider: string; model: string }
  }> = []
  /** Session-creation metas by session id, for asserting peer composition. */
  readonly metas = new Map<string, { cwd: string; origin?: string; agentProfile?: string }>()
  /** Delay before a delivered turn settles; raise it past a budget to keep turns running. */
  settleMs = 10
  /** When set, `create` rejects to exercise the creation-failure mapping. */
  createFails = false
  /** When set, `followup` rejects to exercise the busy mapping. */
  followupFails = false
  /** When set, settle stops after the claim, leaving the turn outstanding. */
  halfSettle = false
  /** When set, `get` reports no resident agent while `resume` still succeeds. */
  hideGet = false
  /** When set, settle emits a reasoning-only step so the reply stays empty. */
  reasoningOnly = false
  /** When set, the setup context carries no agent facet. */
  setupAgent = true
  closed: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  get(id: string) {
    return this.hideGet ? undefined : this.entries.get(id)
  }

  async create(options: {
    sessionId: string
    meta: { cwd: string; origin?: string; agentProfile?: string }
    setup: (ctx: Context) => Promise<void>
  }) {
    if (this.createFails) throw new Error('registry refused')
    this.createOptions.push(options)
    await options.setup((this.setupAgent
      ? { agent: { session: { id: options.sessionId } } }
      : { agent: undefined }) as unknown as Context)
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
        if (this.followupFails) throw new Error('agent closing')
        const prompt = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
        entry.status = 'running'
        idle = new Promise((resolve) => {
          setTimeout(() => {
            const turn = 1 + events.filter(event => event.type === 'turn/end').length
            events.push({ type: 'turn/start', seq: events.length, data: { turn } })
            events.push({ type: 'user/message', seq: events.length, data: message })
            if (this.halfSettle) {
              entry.status = 'running'
              return
            }
            const content = this.reasoningOnly
              ? [{ type: 'reasoning', text: 'thinking' }]
              : [{ type: 'text', text: `done: ${prompt}` }]
            events.push({ type: 'assistant/message', seq: events.length, data: { turn, step: 1, message: { content } } })
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

/** A scripted presets service standing in for dsh-agent-presets. */
class FakePresets extends Service {
  mounted: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'agentPresets')
  }

  async resolve(id?: string): Promise<{ id: string }> {
    if (id === 'missing') throw new Error('no such preset')
    return { id: id ?? 'default-profile' }
  }

  async mount(agentCtx: Context, id: string): Promise<void> {
    this.mounted.push(`${agentCtx.agent?.id ?? 'agent'}:${id}`)
  }
}

/** A scripted default-model service standing in for dsh-agent-default-model. */
class FakeDefaultModel extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentDefaultModel')
  }

  currentSelection(): { provider: string; model: string } {
    return { provider: 'deepseek', model: 'test-model' }
  }
}

/** Mount the host with a scripted registry and one pinned active caller record.
 * @param surface - the caller's approved surface.
 * @param extras - optional presets, default-model, and registry wiring.
 */
async function rig(
  surface: { delegate: boolean; message: boolean; list: boolean } = { delegate: true, message: true, list: true },
  extras: { presets?: boolean; defaultModel?: boolean; modelPolicy?: boolean; agents?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'peer-delegate-'))
  directories.push(root)
  await ensureInstanceIdentity(root)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  if (extras.agents !== false) await ctx.plugin(FakeAgentRegistry)
  if (extras.presets === true) await ctx.plugin(FakePresets)
  if (extras.defaultModel === true) await ctx.plugin(FakeDefaultModel)
  if (extras.modelPolicy === true) await ctx.plugin(FakeModelPolicy)
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
  return {
    root, ctx, host: ctx.peerHost, key,
    registry: ctx.get('agents') as unknown as FakeAgentRegistry,
    presets: ctx.get('agentPresets') as unknown as FakePresets | undefined,
  }
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

/** A scripted model-policy service standing in for dsh-model-policy. */
class FakeModelPolicy extends Service {
  initialized: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'modelPolicy')
  }

  initialize(session: { id?: string }): void {
    this.initialized.push(session.id ?? 'session')
  }
}

it('initializes the composed model policy with each delegated session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'peer-delegate-'))
  directories.push(root)
  await ensureInstanceIdentity(root)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(FakeAgentRegistry)
  const policy = new FakeModelPolicy(ctx)
  await ctx.plugin(PeerHost, { dshHome: root })
  const key = identityKey()
  const record: PeerRecord = {
    instanceId: caller, displayName: 'Laptop', platform: 'darwin', arch: 'arm64', version: '1.0.0-rc.3',
    surface: { delegate: true, message: true, list: true }, pairedVia: 'invitation', status: 'active',
    identityPublicKey: key.publicKey,
    firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
  }
  await writePeerStore(root, [record])
  const host = ctx.peerHost
  const result = await host.delegate({ proof: proofFor(key), prompt: 'p' })
  expect(policy.initialized).toEqual([result.sessionId])
})

it('rejects unknown and revoked callers on every request family', async () => {
  const { root, host, key } = await rig()
  const stranger = identityKey()
  const strangerProof = (() => {
    const timestamp = Date.now()
    return { instanceId: '99999999-1111-4222-8333-444455556666', timestamp, signature: stranger.sign(peerRequestMessage('99999999-1111-4222-8333-444455556666', timestamp)) }
  })()
  await expect(host.sessions({ proof: strangerProof })).rejects.toThrowError(/RECORD_NOT_FOUND/)
  await writePeerStore(root, (await readPeerStore(root)).map(peer => ({ ...peer, status: 'revoked' as const })))
  await expect(host.sessions({ proof: proofFor(key) })).rejects.toThrowError(/HELLO_REJECTED/)
  const { host: fresh } = await rig()
  await expect(fresh.followup({ proof: null as never, sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', prompt: 'p' }))
    .rejects.toThrowError(/INVALID_PAYLOAD/)
})

it('labels sessions by first line, empties reasoning-only replies, and resumes under a default model', async () => {
  const multiline = await rig()
  const long = await multiline.host.delegate({ proof: proofFor(multiline.key), prompt: `${'x'.repeat(100)}\nsecond` })
  const sessions = await readPeerSessions(multiline.root)
  expect(sessions.find(entry => entry.sessionId === long.sessionId)!.label).toBe('x'.repeat(64))
  multiline.registry.reasoningOnly = true
  const quiet = await multiline.host.delegate({ proof: proofFor(multiline.key), prompt: 'think quietly' })
  expect(quiet).toMatchObject({ state: 'settled' })
  expect(quiet.reply).toBeUndefined()
  expect(quiet.endReason).toBe('completed')
  const modelled = await rig(undefined, { defaultModel: true, modelPolicy: true })
  modelled.registry.setupAgent = false
  const seeded = await modelled.host.delegate({ proof: proofFor(modelled.key), prompt: 'p' })
  modelled.registry.setupAgent = true
  modelled.registry.hideGet = true
  modelled.registry.setupAgent = false
  const resumed = await modelled.host.followup({ proof: proofFor(modelled.key), sessionId: seeded.sessionId, prompt: 'q' })
  expect(resumed.reply).toBe('done: q')
  modelled.registry.hideGet = false
  const states = await modelled.host.sessions({ proof: proofFor(modelled.key) })
  expect(states.sessions.find(entry => entry.sessionId === seeded.sessionId)!.state).toBe('idle')
  modelled.registry.entries.get(seeded.sessionId)!.status = 'running'
  const active = await modelled.host.sessions({ proof: proofFor(modelled.key) })
  expect(active.sessions.find(entry => entry.sessionId === seeded.sessionId)!.state).toBe('running')
})

it('drops registry entries for peers with no live agents on removal', async () => {
  const { root, host, key, registry } = await rig()
  await host.delegate({ proof: proofFor(key), prompt: 'p' })
  await writePeerSessions(root, [...(await readPeerSessions(root)), {
    sessionId: 'peer-99999999-9999-4999-8999-999999999999', peerInstanceId: other,
    createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
    cwd: join(root, 'peer-work', other), label: 'foreign',
  }])
  registry.entries.clear()
  await host.removePeer(caller)
  expect((await readPeerSessions(root)).map(entry => entry.peerInstanceId)).toEqual([other])
})

it('composes delegated sessions through presets and the deployment default model', async () => {
  const { host, key, registry, presets } = await rig(undefined, { presets: true, defaultModel: true, modelPolicy: true })
  registry.setupAgent = false
  await host.delegate({ proof: proofFor(key), prompt: 'p', profile: 'standard' })
  registry.setupAgent = true
  await host.delegate({ proof: proofFor(key), prompt: 'p' })
  expect(registry.createOptions[0]).toMatchObject({
    meta: { origin: 'peer', agentProfile: 'standard' },
    agentOptions: { provider: 'deepseek', model: 'test-model' },
  })
  expect(presets!.mounted[0]).toContain('standard')
  await expect(host.delegate({ proof: proofFor(key), prompt: 'p', profile: 'missing' })).rejects.toThrowError(/INVALID_PAYLOAD/)
})

it('fails closed when no agent registry is composed', async () => {
  const { host, key, ctx } = await rig(undefined, { agents: false })
  await expect(host.delegate({ proof: proofFor(key), prompt: 'p' })).rejects.toThrowError(/SESSION_BUSY/)
  const settled = await writePeerSessionManually(ctx)
  await expect(host.followup({ proof: proofFor(key), sessionId: settled, prompt: 'p' })).rejects.toThrowError(/SESSION_BUSY/)
})

/** Seed one registry entry directly, without a live agent.
 * @param ctx - the mounted context.
 * @returns the seeded session id.
 */
async function writePeerSessionManually(ctx: Context): Promise<string> {
  const root = (ctx.peerHost as { home: string }).home
  const sessionId = 'peer-11111111-2222-4333-8444-555566667777'
  await writePeerSessions(root, [{
    sessionId, peerInstanceId: caller,
    createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
    cwd: join(root, 'peer-work', caller), label: 'seeded',
  }])
  return sessionId
}

it('reports busy agents, refused creations, and failed resumes with closed reasons', async () => {
  const { ctx, host, key, registry } = await rig()
  registry.createFails = true
  await expect(host.delegate({ proof: proofFor(key), prompt: 'p' })).rejects.toThrowError(/SESSION_BUSY/)
  registry.createFails = false
  registry.followupFails = true
  await expect(host.delegate({ proof: proofFor(key), prompt: 'p' })).rejects.toThrowError(/SESSION_BUSY/)
  registry.followupFails = false
  const seeded = await writePeerSessionManually(ctx)
  await expect(host.followup({ proof: proofFor(key), sessionId: seeded, prompt: 'q' })).rejects.toThrowError(/SESSION_NOT_FOUND/)
  registry.hideGet = true
  const first = await host.delegate({ proof: proofFor(key), prompt: 'p' })
  const resumed = await host.followup({ proof: proofFor(key), sessionId: first.sessionId, prompt: 'q' })
  expect(resumed.reply).toBe('done: q')
  const second = await rig()
  await expect(second.host.delegate({ proof: proofFor(second.key), prompt: 'p' })).resolves.toBeDefined()
})

it('maps an unwritable peer working directory onto the closed reason', async () => {
  const { root, host, key } = await rig()
  await writeFile(join(root, 'peer-work'), 'a plain file blocks the working directory')
  await expect(host.delegate({ proof: proofFor(key), prompt: 'p' })).rejects.toThrowError(/STORE_FAILED/)
})

it('reports running when the claim landed but the turn stays outstanding', async () => {
  const { host, key, registry } = await rig()
  registry.halfSettle = true
  const result = await host.delegate({ proof: proofFor(key), prompt: 'p', timeoutMs: 500 })
  expect(result.state).toBe('running')
  expect(result.reply).toBeUndefined()
})

it('rejects malformed delegate, follow-up, and sessions requests', async () => {
  const { host, key } = await rig()
  await expect(host.delegate({ proof: null as never, prompt: 'p' })).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.delegate({ proof: proofFor(key), prompt: 'p', profile: 'x'.repeat(129) })).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.followup(null as never)).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.followup({ proof: proofFor(key), sessionId: 'chat-1', prompt: 'p' })).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.followup({ proof: proofFor(key), sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', prompt: '' })).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.sessions(null as never)).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.sessions({ proof: null as never })).rejects.toThrowError(/INVALID_PAYLOAD/)
})

it('orders enumeration by newest activity across both directions', async () => {
  const { root, host, key } = await rig()
  const first = await host.delegate({ proof: proofFor(key), prompt: 'first' })
  const second = await host.delegate({ proof: proofFor(key), prompt: 'second' })
  const sessions = await readPeerSessions(root)
  await writePeerSessions(root, sessions.map(entry => entry.sessionId === first.sessionId
    ? { ...entry, lastActivityAt: '2027-01-01T00:00:00.000Z' }
    : entry))
  const listed = await host.sessions({ proof: proofFor(key) })
  expect(listed.sessions.map(entry => entry.sessionId)).toEqual([first.sessionId, second.sessionId])
})
