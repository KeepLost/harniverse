/** Delegate, follow-up, and enumeration Remotes over a scripted agent registry. */

import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { ensureInstanceIdentity, peerInstanceId, peerRequestMessage } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerRecord, PeerRequestProof } from '@deepseek-ai/dsh-peer-protocol'
import PeerHost from '../src/index.ts'
import { readPeerSessions, writePeerSessions } from '../src/session-registry.ts'
import { periodOf, readPeerGovernance, writePeerGovernance } from '../src/governance.ts'
import { PEER_CHUNK_MAX_BYTES, stagedUploadExists } from '../src/staging.ts'
import { PEER_DOWNLOAD_MAX_BYTES } from '../src/delegate.ts'
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
  /** Every delivered user message in full, including its source fields. */
  readonly delivered: Array<{
    id: string
    content: Array<{ type: string; text?: string }>
    source?: { kind: string; files?: unknown[] }
  }> = []
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
    let settle: (() => void) | undefined
    const entry = {
      status: 'idle' as 'idle' | 'running',
      session,
      whenIdle: () => idle,
      cancel: (cause: { kind: string }) => {
        if (settle !== undefined) {
          events.push({ type: 'turn/end', seq: events.length, data: { turn: 1 + events.filter(event => event.type === 'turn/end').length, reason: { kind: cause.kind } } })
          entry.status = 'idle'
          settle()
        }
      },
      followup: (message: { id: string; content: Array<{ type: string; text?: string }> }) => {
        this.delivered.push(message)
        if (this.followupFails) throw new Error('agent closing')
        const prompt = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
        entry.status = 'running'
        const turn = 1 + events.filter(event => event.type === 'turn/end').length
        events.push({ type: 'turn/start', seq: events.length, data: { turn } })
        events.push({ type: 'user/message', seq: events.length, data: message })
        idle = new Promise((resolve) => {
          const timer = setTimeout(() => {
            settle = undefined
            if (!this.halfSettle) {
              const content = this.reasoningOnly
                ? [{ type: 'reasoning', text: 'thinking' }]
                : [{ type: 'text', text: `done: ${prompt}` }]
              events.push({ type: 'assistant/message', seq: events.length, data: { turn, step: 1, message: { content } } })
              events.push({ type: 'turn/end', seq: events.length, data: { turn, reason: { kind: 'completed' } } })
              entry.status = 'idle'
            }
            resolve()
          }, this.settleMs)
          settle = () => {
            clearTimeout(timer)
            resolve()
          }
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
  surface: { delegate: boolean; message: boolean; list: boolean; artifacts: boolean }
    = { delegate: true, message: true, list: true, artifacts: true },
  extras: { presets?: boolean; defaultModel?: boolean; modelPolicy?: boolean; agents?: boolean; attachments?: boolean } = {},
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
  if (extras.attachments === true) await ctx.plugin(FakeAttachmentStore)
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
    attachments: ctx.get('attachments') as unknown as FakeAttachmentStore | undefined,
  }
}

/** Mint one valid request proof for the caller.
 * @param key - the caller's signing identity.
 */
function proofFor(key: ReturnType<typeof identityKey>): PeerRequestProof {
  const timestamp = Date.now()
  const nonce = randomUUID()
  return { instanceId: caller, timestamp, nonce, signature: key.sign(peerRequestMessage(caller, timestamp, nonce)) }
}

it('rejects capped peers before minting artifacts and counts accepted turns', async () => {
  const { root, host, key } = await rig()
  const period = periodOf(new Date())
  await writePeerGovernance(root, [{ instanceId: caller, monthlyTurns: 1, spent: { [period]: 1 } }])
  await expect(host.delegate({ proof: proofFor(key), prompt: 'first' })).rejects.toThrowError(/BUDGET_EXCEEDED/)
  await expect(host.followup({ proof: proofFor(key), sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', prompt: 'next' }))
    .rejects.toThrowError(/BUDGET_EXCEEDED/)
  expect(await readPeerSessions(root)).toEqual([])
  // Lifting to a working cap lets the turn through and records its acceptance.
  await writePeerGovernance(root, [{ instanceId: caller, monthlyTurns: 2, spent: { [period]: 1 } }])
  const settled = await host.delegate({ proof: proofFor(key), prompt: 'second' })
  expect(settled.state).toBe('settled')
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: caller, monthlyTurns: 2, spent: { [period]: 2 } }])
  // A running turn still consumed budget on acceptance, and the next one is capped out.
  await writePeerGovernance(root, [{ instanceId: caller, monthlyTurns: 3, spent: { [period]: 2 } }])
  const followup = await host.followup({ proof: proofFor(key), sessionId: settled.sessionId, prompt: 'third' })
  expect(followup.state).toBe('settled')
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: caller, monthlyTurns: 3, spent: { [period]: 3 } }])
  await expect(host.delegate({ proof: proofFor(key), prompt: 'fourth' })).rejects.toThrowError(/BUDGET_EXCEEDED/)
})

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

it('cancels the running current turn and reports idle sessions as already settled', async () => {
  const { root, host, key, registry } = await rig()
  const created = await host.delegate({ proof: proofFor(key), prompt: 'work', timeoutMs: 20 })
  const settled = await host.cancel({ proof: proofFor(key), sessionId: created.sessionId })
  expect(settled).toMatchObject({ sessionId: created.sessionId, messageId: created.messageId, state: 'settled', endReason: 'completed' })

  registry.settleMs = 10_000
  const running = await host.followup({ proof: proofFor(key), sessionId: created.sessionId, prompt: 'slow', timeoutMs: 20 })
  expect(running.state).toBe('running')
  const cancelled = await host.cancel({ proof: proofFor(key), sessionId: created.sessionId })
  expect(cancelled).toMatchObject({ sessionId: created.sessionId, state: 'settled', endReason: 'user' })

  await expect(host.cancel({ proof: proofFor(key), sessionId: 'peer-00000000-0000-4000-8000-000000000000' }))
    .rejects.toThrowError(/SESSION_NOT_FOUND/)
  const sessions = await readPeerSessions(root)
  await writePeerSessions(root, sessions.map(entry => ({ ...entry, peerInstanceId: other })))
  await expect(host.cancel({ proof: proofFor(key), sessionId: created.sessionId })).rejects.toThrowError(/SESSION_NOT_FOUND/)
  await writePeerSessions(root, sessions)
  registry.entries.clear()
  await expect(host.cancel({ proof: proofFor(key), sessionId: created.sessionId })).rejects.toThrowError(/SESSION_NOT_FOUND/)
  await expect(host.cancel({ proof: undefined as never, sessionId: created.sessionId })).rejects.toThrowError(/INVALID_PAYLOAD/)
})

it('cancels an idle session with an outstanding claim as still running', async () => {
  const { host, key, registry } = await rig()
  registry.settleMs = 10_000
  const created = await host.delegate({ proof: proofFor(key), prompt: 'held', timeoutMs: 20 })
  expect(created.state).toBe('running')
  registry.entries.get(created.sessionId)!.status = 'idle'
  const cancelled = await host.cancel({ proof: proofFor(key), sessionId: created.sessionId })
  expect(cancelled).toMatchObject({ sessionId: created.sessionId, messageId: created.messageId, state: 'running' })
})

it('cancels an idle session whose resident window no longer shows a claim', async () => {
  const { root, host, key, registry } = await rig()
  const created = await host.delegate({ proof: proofFor(key), prompt: 'work' })
  registry.entries.get(created.sessionId)!.session.events.length = 0
  await expect(host.cancel({ proof: proofFor(key), sessionId: created.sessionId }))
    .rejects.toThrowError(/turn is no longer observable live/)
  expect(root).toBeDefined()
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
  const { host, key } = await rig({ delegate: false, message: false, list: false, artifacts: false })
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

/** A scripted attachment store admitting generic files into memory. */
class FakeAttachmentStore extends Service {
  /** Saved files keyed by content digest; each entry records the ref and handle path. */
  readonly saved: Array<{ name: string; mediaType?: string; bytes: number; data: Uint8Array }> = []
  /** Published read-only handle paths by attachment digest. */
  readonly handles: string[] = []
  /** When set, `saveFile` rejects with the configured AttachmentError code. */
  saveFailsWith: AttachmentError['code'] | undefined
  /** When set, `saveFile` rejects with a plain Error instead of an AttachmentError. */
  saveThrowsRaw = false
  /** When set, `publishFileHandle` rejects with the configured AttachmentError code. */
  handleFailsWith: AttachmentError['code'] | undefined

  constructor(ctx: Context, readonly acceptsFiles = true) {
    super(ctx, 'attachments')
  }

  get imageLimits() {
    return { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, mediaTypes: [] as never[] }
  }

  get fileLimits() {
    return this.acceptsFiles ? { maxFileBytes: 64 * 1024 * 1024 } : undefined
  }

  async validateImage(): Promise<void> {}

  async saveImage(): Promise<never> {
    throw new Error('unused')
  }

  async saveFile(input: { data: Uint8Array; mediaType?: string; name?: string })
    : Promise<{ attachmentId: string; bytes: number; name?: string; mediaType?: string }> {
    if (this.saveThrowsRaw) throw new Error('disk on fire')
    if (this.saveFailsWith !== undefined) {
      throw new AttachmentError('store refused', this.saveFailsWith)
    }
    this.saved.push({ name: input.name ?? 'unnamed', ...input.mediaType === undefined ? {} : { mediaType: input.mediaType }, bytes: input.data.byteLength, data: input.data })
    return {
      attachmentId: `sha256:${String(this.saved.length - 1).padStart(64, '0')}`,
      bytes: input.data.byteLength,
      ...input.name === undefined ? {} : { name: input.name },
      ...input.mediaType === undefined ? {} : { mediaType: input.mediaType },
    }
  }

  async publishFileHandle(ref: { bytes: number; name?: string }): Promise<string> {
    if (this.handleFailsWith !== undefined) {
      throw new AttachmentError('handle refused', this.handleFailsWith)
    }
    const path = `/ro/${ref.name ?? 'file'}`
    this.handles.push(path)
    return path
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
    surface: { delegate: true, message: true, list: true, artifacts: true }, pairedVia: 'invitation', status: 'active',
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
    const nonce = randomUUID()
    return { instanceId: '99999999-1111-4222-8333-444455556666', timestamp, nonce, signature: stranger.sign(peerRequestMessage('99999999-1111-4222-8333-444455556666', timestamp, nonce)) }
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

it('delivers staged uploads through the attachment pipeline as message files', async () => {
  const { root, host, key, registry } = await rig({ delegate: true, message: true, list: true, artifacts: true },
    { attachments: true })
  const data = new Uint8Array(3000)
  crypto.getRandomValues(data)
  const sha256 = createHash('sha256').update(data).digest('base64url')
  const begin = await host.upload({ proof: proofFor(key), manifest: { name: 'logs.tar', mediaType: 'application/x-tar', bytes: 3000, sha256 } })
  expect(begin.maxChunkBytes).toBe(PEER_CHUNK_MAX_BYTES)
  expect(begin.maxFileBytes).toBe(64 * 1024 * 1024)
  for (let offset = 0; offset < 3000; offset += 1024) {
    const chunk = data.subarray(offset, Math.min(offset + 1024, 3000))
    await host.append({ proof: proofFor(key), uploadId: begin.uploadId, offset, dataBase64: Buffer.from(chunk).toString('base64') })
  }
  const result = await host.delegate({ proof: proofFor(key), prompt: 'analyze the archive', uploads: [{ uploadId: begin.uploadId, sha256 }] })
  expect(result.state).toBe('settled')
  const store = registry.delivered
  expect(store.at(-1)!.content[0]).toEqual({ type: 'text', text: 'analyze the archive' })
  expect(store.at(-1)!.content[1]!.text).toContain('logs.tar')
  expect(store.at(-1)!.content[1]!.text).toContain('只读路径')
  const admitted = (store.at(-1)!.source as {
    files?: Array<{ attachmentId?: unknown; bytes?: unknown; name?: unknown; mediaType?: unknown }>
  }).files ?? []
  expect(admitted).toHaveLength(1)
  expect(String(admitted[0]!.attachmentId)).toMatch(/^sha256:/)
  expect(admitted[0]!.bytes).toBe(3000)
  expect(admitted[0]!.name).toBe('logs.tar')
  expect(admitted[0]!.mediaType).toBe('application/x-tar')
  // The staged slot is consumed and the bytes metered against the peer's byte budget.
  expect(await stagedUploadExists(root, caller, begin.uploadId)).toBe(false)
  const period = periodOf(new Date())
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: caller, spent: { [period]: 1 },
    spentBytes: { [period]: 3000 } }])
})

it('rejects artifact calls without the artifacts grant or without an attachment store', async () => {
  const denied = await rig({ delegate: true, message: true, list: true, artifacts: false }, { attachments: true })
  const data = new Uint8Array(4)
  const sha256 = createHash('sha256').update(data).digest('base64url')
  await expect(denied.host.upload({ proof: proofFor(denied.key), manifest: { name: 'a.bin', bytes: 4, sha256 } })).rejects.toThrowError(/SURFACE_DENIED/)
  await expect(denied.host.download({ proof: proofFor(denied.key), path: 'out.txt' })).rejects.toThrowError(/SURFACE_DENIED/)
  const bare = await rig()
  await expect(bare.host.upload({ proof: proofFor(bare.key), manifest: { name: 'a.bin', bytes: 4, sha256 } })).rejects.toThrowError(/ATTACHMENT_REFUSED/)
})

it('maps attachment-pipeline refusals onto the closed artifact reasons', async () => {
  const { host, key, attachments } = await rig({ delegate: true, message: true, list: true, artifacts: true }, { attachments: true })
  const data = new Uint8Array(4)
  const sha256 = createHash('sha256').update(data).digest('base64url')
  attachments!.saveFailsWith = 'FILE_TOO_LARGE'
  const oversized = await host.upload({ proof: proofFor(key), manifest: { name: 'big.bin', bytes: 4, sha256 } })
  await host.append({ proof: proofFor(key), uploadId: oversized.uploadId, offset: 0, dataBase64: Buffer.from(data).toString('base64') })
  attachments!.saveFailsWith = 'FILE_UPLOAD_UNSUPPORTED'
  await expect(host.delegate({ proof: proofFor(key), prompt: 'take it', uploads: [{ uploadId: oversized.uploadId, sha256 }] }))
    .rejects.toThrowError(/ATTACHMENT_REFUSED/)
})

it('reads bounded workspace files back and records the carried bytes', async () => {
  const { root, host, key } = await rig()
  const work = join(root, 'peer-work', caller)
  await mkdir(work, { recursive: true })
  await writeFile(join(work, 'report.txt'), 'results', { flag: 'w' })
  const file = await host.download({ proof: proofFor(key), path: 'report.txt' })
  expect(file.name).toBe('report.txt')
  expect(file.bytes).toBe(7)
  expect(file.dataBase64).toBe(Buffer.from('results').toString('base64'))
  await expect(host.download({ proof: proofFor(key), path: 'missing.txt' })).rejects.toThrowError(/file not found/)
  await expect(host.download({ proof: proofFor(key), path: '../secrets' })).rejects.toThrowError(/INVALID_PAYLOAD/)
  // A file past the single-frame cap refuses without reading it into memory first.
  const huge = join(work, 'huge.bin')
  const handle = await open(huge, 'w')
  await handle.truncate(PEER_DOWNLOAD_MAX_BYTES + 1)
  await handle.close()
  await expect(host.download({ proof: proofFor(key), path: 'huge.bin' })).rejects.toThrowError(/ATTACHMENT_TOO_LARGE/)
  const period = periodOf(new Date())
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: caller, spent: {}, spentBytes: { [period]: 7 } }])
})

it('rejects appends past the monthly byte budget before any byte lands', async () => {
  const { root, host, key } = await rig({ delegate: true, message: true, list: true, artifacts: true }, { attachments: true })
  const period = periodOf(new Date())
  await writePeerGovernance(root, [{ instanceId: caller, monthlyBytes: 8, spent: {}, spentBytes: { [period]: 6 } }])
  const data = new Uint8Array(4)
  const sha256 = createHash('sha256').update(data).digest('base64url')
  const begin = await host.upload({ proof: proofFor(key), manifest: { name: 'a.bin', bytes: 4, sha256 } })
  // A chunk the cap can still carry lands and meters; the next three-byte chunk cannot.
  await host.append({ proof: proofFor(key), uploadId: begin.uploadId, offset: 0, dataBase64: Buffer.from(data.subarray(0, 2)).toString('base64') })
  await expect(host.append({ proof: proofFor(key), uploadId: begin.uploadId, offset: 2, dataBase64: Buffer.from(data.subarray(2)).toString('base64') }))
    .rejects.toThrowError(/BUDGET_EXCEEDED/)
  expect(await readPeerGovernance(root)).toEqual([{ instanceId: caller, monthlyBytes: 8, spent: {}, spentBytes: { [period]: 8 } }])
})

it('rejects malformed upload references and artifact Remotes with the closed reasons', async () => {
  const { host, key, attachments } = await rig({ delegate: true, message: true, list: true, artifacts: true }, { attachments: true })
  const data = new Uint8Array(4)
  const sha256 = createHash('sha256').update(data).digest('base64url')
  const ref = { uploadId: '00000000-0000-4000-8000-00000000000a', sha256: 'A'.repeat(43) }
  await expect(host.delegate({ proof: proofFor(key), prompt: 'x', uploads: [] })).rejects.toThrowError(/uploads out of range/)
  await expect(host.delegate({ proof: proofFor(key), prompt: 'x', uploads: ['bad' as never] })).rejects.toThrowError(/not an object/)
  await expect(host.delegate({ proof: proofFor(key), prompt: 'x', uploads: [{ uploadId: 'x', sha256: 'y' }] })).rejects.toThrowError(/reference fields/)
  await expect(host.delegate({ proof: proofFor(key), prompt: 'x', uploads: [ref, ref, ref, ref, ref] })).rejects.toThrowError(/uploads out of range/)
  await expect(host.followup({ proof: proofFor(key), sessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef', prompt: 'x', uploads: [] }))
    .rejects.toThrowError(/uploads out of range/)
  // A delegate naming uploads without any mounted store refuses the whole turn.
  const bare = await rig()
  await expect(bare.host.delegate({ proof: proofFor(bare.key), prompt: 'x', uploads: [ref] }))
    .rejects.toThrowError(/ATTACHMENT_REFUSED/)
  // Remote-level shape validation for the artifact verbs.
  await expect(host.upload('nope' as never)).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.append('nope' as never)).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.download('nope' as never)).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.upload({ proof: proofFor(key) } as never)).rejects.toThrowError(/INVALID_PAYLOAD/)
  await expect(host.append({ proof: proofFor(key), uploadId: 'short', offset: 0, dataBase64: 'YQ==' })).rejects.toThrowError(/append fields/)
  await expect(host.append({ proof: proofFor(key), uploadId: ref.uploadId, offset: -1, dataBase64: 'YQ==' })).rejects.toThrowError(/append fields/)
  await expect(host.append({ proof: proofFor(key), uploadId: ref.uploadId, offset: 0, dataBase64: '' })).rejects.toThrowError(/append fields/)
  await expect(host.append({ proof: proofFor(key), uploadId: ref.uploadId, offset: 0, dataBase64: '!!' })).rejects.toThrowError(/canonical base64/)
  await expect(host.download({ proof: proofFor(key), path: '' })).rejects.toThrowError(/download fields/)
  await expect(host.download({ proof: proofFor(key), path: 'x'.repeat(513) })).rejects.toThrowError(/download fields/)
  // A store throwing a raw non-attachment failure maps onto the generic refused reason.
  attachments!.saveThrowsRaw = true
  const raw = await host.upload({ proof: proofFor(key), manifest: { name: 'z.bin', bytes: 4, sha256 } })
  await host.append({ proof: proofFor(key), uploadId: raw.uploadId, offset: 0, dataBase64: Buffer.from(data).toString('base64') })
  await expect(host.delegate({ proof: proofFor(key), prompt: 'x', uploads: [{ uploadId: raw.uploadId, sha256 }] }))
    .rejects.toThrowError(/ATTACHMENT_REFUSED/)
  attachments!.saveThrowsRaw = false
  // The artifacts grant gates the append verb independently of the begin verb.
  const denied = await rig({ delegate: true, message: true, list: true, artifacts: false }, { attachments: true })
  await expect(denied.host.append({ proof: proofFor(denied.key), uploadId: ref.uploadId, offset: 0, dataBase64: 'YQ==' }))
    .rejects.toThrowError(/SURFACE_DENIED/)
  // A store that rejects the save fails the turn, and a handle-publication failure fails it before delivery.
  const begin = await host.upload({ proof: proofFor(key), manifest: { name: 'h.bin', bytes: 4, sha256 } })
  await host.append({ proof: proofFor(key), uploadId: begin.uploadId, offset: 0, dataBase64: Buffer.from(data).toString('base64') })
  attachments!.saveFailsWith = 'FILE_TOO_LARGE'
  await expect(host.delegate({ proof: proofFor(key), prompt: 'x', uploads: [{ uploadId: begin.uploadId, sha256 }] }))
    .rejects.toThrowError(/ATTACHMENT_TOO_LARGE/)
  attachments!.saveFailsWith = undefined
  const handled = await host.upload({ proof: proofFor(key), manifest: { name: 'h2.bin', bytes: 4, sha256 } })
  await host.append({ proof: proofFor(key), uploadId: handled.uploadId, offset: 0, dataBase64: Buffer.from(data).toString('base64') })
  attachments!.handleFailsWith = 'FILE_TOO_LARGE'
  await expect(host.delegate({ proof: proofFor(key), prompt: 'x', uploads: [{ uploadId: handled.uploadId, sha256 }] }))
    .rejects.toThrowError(/ATTACHMENT_TOO_LARGE/)
})
