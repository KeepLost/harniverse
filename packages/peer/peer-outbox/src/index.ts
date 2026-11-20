/**
 * Initiator-side peer settlement ledger (`ctx.peerOutbox`): tracks delegated
 * turns an online target already accepted but that outran the tool budget,
 * polls their settlement read-only, and delivers the settled reply into the
 * initiating session as a plugin-sourced user message. The ledger holds no
 * unsent work and retries nothing: an unreachable target fails the entry
 * after exactly one immediate re-probe, per the pairing contract that both
 * instances must be online.
 * @module @deepseek-ai/dsh-peer-outbox
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { ensureInstanceIdentity, PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerRunResult, PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import {
  ensurePeerIdentityKey,
  readPeerTargets,
  runPeerResult,
  withPeerTransport,
} from '@deepseek-ai/dsh-peer-client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { PeerOutboxEntry, PeerOutboxFailure, PeerOutboxTrackInput } from './types.ts'
import { peerOutboxDomainSpec } from './spec.ts'
import { outboxDeliveryMessage } from './envelope.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    peerOutbox: PeerOutbox
  }
}

/** Peer outbox configuration. */
export interface PeerOutboxConfig {
  /** Harness home override; absent means standard `DSH_HOME` resolution. */
  dshHome?: string
  /** Poll cadence for watching entries in milliseconds (default 30000, minimum 100). */
  pollIntervalMs?: number
  /** Stored and delivered reply ceiling, in characters (default 50000). */
  maxResultChars?: number
}

/** Upper bound on one settlement read's transport timeout. */
const RESULT_CALL_MS = 30_000

/** Terminal entries retained for inspection; older terminal entries are pruned newest-first-kept. */
const MAX_RETAINED_TERMINAL = 200

/** Peer outbox service; the storage-domain ledger is the authority. */
export class PeerOutbox extends Service {
  static inject = ['agents', 'sessions', 'storageDomain']

  static Config: z<PeerOutboxConfig> = z.object({
    pollIntervalMs: z.natural().min(100).default(30_000),
    maxResultChars: z.natural().min(1).default(50_000),
  })

  private readonly ownerCtx: Context
  private readonly home: string
  private readonly pollIntervalMs: number
  private readonly maxResultChars: number
  private table: KvTable<string, PeerOutboxEntry> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private polling = false
  private closed = false
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: PeerOutboxConfig = {}) {
    super(ctx, 'peerOutbox')
    this.ownerCtx = ctx
    this.home = resolveDshHome(config.dshHome)
    // The exported Config schema (schemastery) has already filled the defaulted
    // fields in every Loader mount; the assertion records that resolution.
    const resolved = config as PeerOutboxConfig & Required<Pick<PeerOutboxConfig, 'pollIntervalMs' | 'maxResultChars'>>
    this.pollIntervalMs = resolved.pollIntervalMs
    this.maxResultChars = resolved.maxResultChars
  }

  /** Current epoch milliseconds; one seam for tests. */
  protected now(): number {
    return Date.now()
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(peerOutboxDomainSpec)
    this.table = domain.table('entries')
    this.ownerCtx.effect(() => async () => {
      this.closed = true
      this.disarm()
      await Promise.allSettled([...this.chains.values()])
      await domain.close()
    }, 'peer-outbox lifecycle')
    this.rearm(this.pollIntervalMs)
  }

  /**
   * All ledger entries, earliest submission first.
   * @returns every stored entry.
   */
  list(): PeerOutboxEntry[] {
    return [...this.requireTable().entries()].map(([, entry]) => entry)
      .sort((a, b) => a.submittedAt - b.submittedAt || a.id.localeCompare(b.id))
  }

  /**
   * Track one accepted-but-running delegated turn. The entry is durable from
   * this call onward: an instance restart resumes the watch on its next poll.
   * @param input - target, peer session, watched turn, and owner session.
   * @returns the stored entry.
   */
  async track(input: PeerOutboxTrackInput): Promise<PeerOutboxEntry> {
    const entry: PeerOutboxEntry = {
      id: randomUUID(),
      targetInstanceId: input.targetInstanceId,
      targetDisplayName: input.targetDisplayName,
      peerSessionId: input.peerSessionId,
      messageId: input.messageId,
      ownerSessionId: input.ownerSessionId,
      label: input.label.length > 64 ? input.label.slice(0, 64) : input.label,
      state: 'watching',
      submittedAt: this.now(),
    }
    await this.requireTable().put(entry.id, entry)
    this.poke()
    return entry
  }

  private requireTable(): KvTable<string, PeerOutboxEntry> {
    /* v8 ignore next 2 -- only reachable between construction and Service.init */
    /* v8 ignore next 3 -- only reachable between construction and Service.init */
    if (this.table === undefined) {
      throw new Error('peer-outbox storage is not ready')
    }
    return this.table
  }

  /** Schedule one poll soon when idle; a running cycle already re-arms itself. */
  private poke(): void {
    if (this.closed || this.polling) return
    this.rearm(0)
  }

  /** Clear the pending timer, if any. */
  private disarm(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Arm the next poll cycle after one delay. */
  private rearm(delay: number): void {
    if (this.closed) return
    this.disarm()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.cycle()
    }, delay)
    this.timer.unref()
  }

  /** Poll every watching entry once, then re-arm. */
  private async cycle(): Promise<void> {
    /* v8 ignore next 1 -- teardown disarms the timer first; the guard only catches a callback already queued at dispose */
    if (this.closed || this.polling) return
    this.polling = true
    try {
      const watching = this.list().filter(entry => entry.state === 'watching')
      for (const entry of watching) {
        void this.enqueue(entry.ownerSessionId, () => this.watch(entry.id))
      }
      await Promise.allSettled(watching
        .map(entry => this.chains.get(entry.ownerSessionId))
        .filter((chain): chain is Promise<unknown> => chain !== undefined))
    } finally {
      this.polling = false
      this.rearm(this.pollIntervalMs)
    }
  }

  /** Serialize per-owner-session work on one chain; the tracked tail never rejects. */
  private enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve()
    const operation = prior.then(work)
    /* v8 ignore next 4 -- overlap between a retired tail and its successor is a benign race; the tracked tail never rejects */
    const retire = (): void => {
      if (this.chains.get(key) === retireChain) this.chains.delete(key)
    }
    /* v8 ignore next 1 -- the tracked tail's rejection arm mirrors its fulfillment arm */
    const retireChain = operation.then(() => undefined, () => undefined).then(retire, retire)
    this.chains.set(key, retireChain)
    return operation
  }

  /** Resolve the active pairing target record one entry addresses. */
  private async resolveTarget(entry: PeerOutboxEntry): Promise<PeerTarget | undefined> {
    return (await readPeerTargets(this.home))
      .find(target => target.targetInstanceId === entry.targetInstanceId && target.status === 'active')
  }

  /** Read one watched turn's settlement, re-probing once against a transport fault. */
  private async readSettlement(target: PeerTarget, entry: PeerOutboxEntry): Promise<PeerRunResult> {
    const identity = await ensureInstanceIdentity(this.home)
    const key = await ensurePeerIdentityKey(this.home)
    const read = (origin: string) => runPeerResult(
      { target, home: this.home, origin, timeoutMs: RESULT_CALL_MS },
      { instanceId: identity.instanceId, key },
      entry.peerSessionId,
      entry.messageId,
    )
    try {
      return await withPeerTransport(this.ownerCtx, this.home, target, read)
    } catch (error) {
      if (!(error instanceof PeerError) || error.reason !== 'TRANSPORT_FAILED') throw error
      // One immediate re-probe guards against a transient network blip; a
      // second fault fails the entry — the ledger never waits for anyone.
      return await withPeerTransport(this.ownerCtx, this.home, target, read)
    }
  }

  /** Watch one entry to a terminal state or leave it watching. */
  private async watch(entryId: string): Promise<void> {
    const entry = this.requireTable().get(entryId)
    /* v8 ignore next 1 -- an entry settled or removed after its cycle snapshot takes no second watch */
    if (entry === undefined || entry.state !== 'watching') return
    const target = await this.resolveTarget(entry)
    if (target === undefined) {
      await this.finish(entry.id, { failureReason: 'TARGET_RECORD_NOT_FOUND' })
      return
    }
    let result: PeerRunResult
    try {
      result = await this.readSettlement(target, entry)
    } catch (error: unknown) {
      const failure = failureOf(error)
      await this.finish(entry.id, { failureReason: failure.reason, failureDetail: failure.detail })
      return
    }
    if (result.state === 'running') return
    const reply = truncate(result.reply ?? '', this.maxResultChars)
    const outcome = {
      reply,
      ...(result.endReason === undefined ? {} : { endReason: result.endReason }),
    }
    const agent = this.ctx.agents.get(entry.ownerSessionId as SessionId)
    if (agent === undefined) {
      await this.finish(entry.id, { ...outcome, failureReason: 'OWNER_SESSION_NOT_LIVE' })
      return
    }
    try {
      await this.deliver(agent, { ...entry, ...outcome }, reply)
    } catch (error: unknown) {
      // A failed delivery must not replay: the entry fails with the reply
      // retained for inspection instead of re-delivering on the next cycle.
      await this.finish(entry.id, {
        ...outcome,
        failureReason: 'READ_FAILED',
        failureDetail: `delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    await this.finish(entry.id, outcome)
  }

  /** Deliver the settled envelope through the idle maintenance phase.
   * @param agent - the live owner agent.
   * @param entry - the terminal entry carrying the observed end reason.
   * @param reply - the truncated settled reply.
   */
  private async deliver(agent: Agent, entry: PeerOutboxEntry, reply: string): Promise<void> {
    const message: UserMessage = outboxDeliveryMessage(entry, reply)
    const send = (): void => {
      agent.followup(message)
    }
    try {
      await agent.runMaintenance(() => {
        send()
        return Promise.resolve(true)
      })
    } catch {
      await waitForAgentIdle(agent)
      await agent.runMaintenance(() => {
        send()
        return Promise.resolve(true)
      })
    }
    await this.ctx.sessions.flush(agent.session)
  }

  /** Move one entry to a terminal state and prune beyond the retention bound. */
  private async finish(id: string, outcome: {
    reply?: string
    endReason?: string
    failureReason?: PeerOutboxFailure
    failureDetail?: string
  }): Promise<void> {
    const table = this.requireTable()
    const entry = table.get(id)
    /* v8 ignore next 1 -- an entry deleted mid-watch settles through its remover's write */
    if (entry === undefined || entry.state !== 'watching') return
    await table.put(id, {
      ...entry,
      state: outcome.failureReason === undefined ? 'settled' : 'failed',
      settledAt: this.now(),
      ...outcome.reply === undefined || outcome.reply.length === 0 ? {} : { reply: outcome.reply },
      ...outcome.endReason === undefined ? {} : { endReason: outcome.endReason },
      ...outcome.failureReason === undefined ? {} : { failureReason: outcome.failureReason },
      ...outcome.failureDetail === undefined ? {} : { failureDetail: outcome.failureDetail },
    })
    await this.prune()
  }

  /** Keep at most {@link MAX_RETAINED_TERMINAL} terminal entries, deleting the oldest first. */
  private async prune(): Promise<void> {
    const table = this.requireTable()
    const terminal = this.list().filter(entry => entry.state !== 'watching')
    const excess = terminal.length - MAX_RETAINED_TERMINAL
    for (let index = 0; index < excess; index += 1) {
      await table.delete((terminal[index] as PeerOutboxEntry).id)
    }
  }
}

/** Peer outbox configuration. */
export interface PeerOutboxConfig {
  /** Harness home override; absent means standard `DSH_HOME` resolution. */
  dshHome?: string
  /** Poll cadence for watching entries in milliseconds (default 30000, minimum 100). */
  pollIntervalMs?: number
  /** Stored and delivered reply ceiling, in characters (default 50000). */
  maxResultChars?: number
}

/** Classify one settlement-read failure onto the closed ledger families.
 * @param error - the thrown settlement read.
 * @returns the failure family and its human-readable detail.
 */
function failureOf(error: unknown): { reason: PeerOutboxFailure; detail: string } {
  if (error instanceof PeerError) {
    if (error.reason === 'TRANSPORT_FAILED') return { reason: 'TARGET_UNREACHABLE', detail: error.message }
    if (error.reason === 'SESSION_NOT_FOUND' || error.reason === 'SURFACE_DENIED') {
      return { reason: 'SESSION_DROPPED', detail: error.message }
    }
    return { reason: 'READ_FAILED', detail: error.message }
  }
  /* v8 ignore next 1 -- every settlement-read throw is a PeerError; the label names a non-Error throw */
  return { reason: 'READ_FAILED', detail: error instanceof Error ? error.message : String(error) }
}

/** Clip one reply to the configured bound with an explicit truncation notice. */
function truncate(reply: string, maxChars: number): string {
  return reply.length > maxChars
    ? `${reply.slice(0, maxChars)}\n… [truncated: ${reply.length - maxChars} more characters]`
    : reply
}

/** Await one running agent's idle boundary. */
async function waitForAgentIdle(agent: Agent): Promise<void> {
  if (agent.status !== 'running') return
  await agent.whenIdle()
}

export default PeerOutbox
