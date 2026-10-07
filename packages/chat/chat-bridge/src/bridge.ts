/**
 * The bridge orchestrator: adapter run loops, inbound admission, command
 * dispatch, prompt submission, and mux frame fan-out. Policy lives here and
 * only here; adapters and the Harniverse client stay policy-free.
 * @module @deepseek-ai/dsh-chat-bridge/bridge
 */

import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  ChatAdapterError, chatAdapterKey,
  type ChatAdapter, type ChatInbound, type ChatInboundSink, type ChatRoute,
} from '@deepseek-ai/dsh-chat-adapter'
import { HarniverseError, type HarniverseMux, type MuxDelivery, type MuxState } from '@deepseek-ai/dsh-chat-harniverse-client'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { DomainError } from '@deepseek-ai/dsh-storage-domain'
import { Interactions, type OwnerRoute } from './interactions.ts'
import { authorize, helpText, parseInput, type CommandName } from './commands.ts'
import { liveSession, type LiveSession, type Origin } from './live.ts'
import {
  identityKey, memberActor, ownerActor, type Actor, type Config,
} from './members.ts'
import { Messenger, type AdapterDirectory, type Log, type Sleeper } from './messenger.ts'
import { issueCode, redeemCode } from './pairing.ts'
import type { BridgeClient } from './ports.ts'
import { KeyedQueue, conversationKey } from './router.ts'
import type { BridgeState, BridgeSessionRecord } from './state.ts'
import { TurnRenderer } from './turns.ts'
import { assertNever } from './never.ts'
import { truncate, withSenderPrefix } from './render.ts'

type MessageEvent = Extract<ChatInbound, { type: 'message' }>
type InteractionEvent = Extract<ChatInbound, { type: 'interaction' }>

/** Everything the bridge is built from. */
export interface BridgeOptions {
  config: Config
  state: BridgeState
  client: BridgeClient
  adapters: AdapterDirectory & { list(): readonly ChatAdapter[] }
  log: Log
  sleep: Sleeper
  /** Observation hook around each queued conversation task. */
  dispatched?: (phase: 'start' | 'end', key: string) => void
  /** Ask the process to exit (long-running mode only). */
  exit?: (code: number) => void
}

/** One inbound message being handled. */
interface Handling {
  adapter: ChatAdapter
  event: MessageEvent
  actor: Actor
  conversation: string
}

/** Longest a stale `/pair` hint is suppressed. */
const HINT_INTERVAL_MS = 3_600_000
/** Cursor write debounce. */
const CURSOR_FLUSH_MS = 1_000
/** Run time after which an adapter failure resets its backoff. */
const HEALTHY_RUN_MS = 30_000
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Render a failure for the person who sent the message.
 * @param error - whatever the handler threw.
 * @returns a short, non-technical sentence.
 */
export function userMessage(error: unknown): string {
  if (error instanceof HarniverseError) {
    if (error.code === 'rpc-rejected') {
      return error.rpcCode === 'session-not-found'
        ? 'That session no longer exists. Send /new to start another.'
        : `The assistant service rejected the request (${error.rpcCode ?? 'unknown'}).`
    }
    if (error.code === 'transport-failed' || error.code === 'authentication-failed' || error.code === 'credential-missing') {
      return 'The assistant service is unavailable right now.'
    }
  }
  return 'Something went wrong handling that message.'
}

/** The chat bridge. */
export class Bridge {
  private readonly messenger: Messenger
  private readonly renderer: TurnRenderer
  private readonly interactions: Interactions
  private readonly queue: KeyedQueue
  private readonly live = new Map<string, LiveSession>()
  private readonly runners = new Map<string, { controller: AbortController; adapter: ChatAdapter; done: Promise<void> }>()
  private readonly adapterStatus = new Map<string, string>()
  private readonly muxes = new Map<string, HarniverseMux>()
  private readonly muxStates = new Map<string, MuxState>()
  private readonly cursors = new Map<string, Record<string, number>>()
  private readonly dirtyCursors = new Set<string>()
  private readonly lastBot = new Map<string, string>()
  private readonly hinted = new Map<string, number>()
  private cursorTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(private readonly o: BridgeOptions) {
    this.messenger = new Messenger(o.adapters, o.log, o.sleep)
    this.renderer = new TurnRenderer(o.config, this.messenger, o.log)
    this.queue = new KeyedQueue({
      start: (key) => { o.dispatched?.('start', key) },
      end: (key) => { o.dispatched?.('end', key) },
    })
    this.interactions = new Interactions({
      config: o.config,
      messenger: this.messenger,
      client: o.client,
      session: sessionId => this.live.get(sessionId),
      owners: () => this.owners(),
      actor: key => this.actorByKey(key),
      log: o.log,
    })
  }

  // ---- lifecycle ----

  /** Load durable state, open the event streams, and start every registered adapter. */
  start(): void {
    for (const [sessionId, record] of this.o.state.table('sessions').entries()) this.live.set(sessionId, liveSession(record))
    for (const [stream, cursor] of this.o.state.table('cursors').entries()) {
      this.cursors.set(stream, { ...cursor })
      for (const [sessionId, seq] of Object.entries(cursor)) {
        const live = this.live.get(sessionId)
        if (live !== undefined) live.applied = seq
      }
    }
    for (const remote of this.streamHosts()) this.openStream(remote)
    for (const adapter of this.o.adapters.list()) this.attach(adapter)
  }

  /** Stop adapters and streams, cancel timers, and persist cursors. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const mux of this.muxes.values()) mux.close()
    for (const runner of this.runners.values()) runner.controller.abort()
    await Promise.all([...this.runners.values()].map(runner => runner.adapter.stop().catch(() => undefined)))
    await Promise.all([...this.runners.values()].map(runner => runner.done))
    this.interactions.dispose()
    await this.flushCursors()
  }

  /**
   * Start the run loop of a newly registered adapter.
   * @param adapter - the adapter.
   */
  attach(adapter: ChatAdapter): void {
    const key = chatAdapterKey(adapter.platform, adapter.botId)
    if (this.stopped || this.runners.has(key)) return
    const controller = new AbortController()
    this.runners.set(key, { controller, adapter, done: this.runLoop(adapter, controller.signal, key) })
  }

  /**
   * Stop the run loop of an adapter that left the registry.
   * @param adapter - the adapter.
   */
  detach(adapter: ChatAdapter): void {
    const key = chatAdapterKey(adapter.platform, adapter.botId)
    const runner = this.runners.get(key)
    if (runner === undefined) return
    this.runners.delete(key)
    this.adapterStatus.delete(key)
    runner.controller.abort()
    void runner.adapter.stop().catch(() => undefined)
  }

  private async runLoop(adapter: ChatAdapter, signal: AbortSignal, key: string): Promise<void> {
    const sink: ChatInboundSink = { accept: event => this.inbound(adapter, event) }
    let failures = 0
    const stopped = (): boolean => signal.aborted
    while (!stopped()) {
      this.adapterStatus.set(key, 'running')
      const startedAt = Date.now()
      try {
        await adapter.run(sink, signal)
        return
      } catch (error) {
        if (stopped()) return
        const code = error instanceof ChatAdapterError ? error.code : 'network'
        if (code === 'auth-failed') {
          this.adapterStatus.set(key, 'the platform credential is invalid, contact the owner')
          this.o.log.warn(`adapter ${key} stopped: credential rejected`, error)
          return
        }
        if (code === 'poll-conflict') {
          this.adapterStatus.set(key, 'another instance is polling this bot; stopped')
          this.o.log.warn(`adapter ${key} stopped: another instance is polling this bot`, error)
          this.o.exit?.(1)
          return
        }
        this.adapterStatus.set(key, 'platform connection interrupted, reconnecting')
        if (Date.now() - startedAt >= HEALTHY_RUN_MS) failures = 0
        const wait = code === 'rate-limited' && error instanceof ChatAdapterError
          ? error.retryAfterMs ?? 0
          : Math.min(30_000, 1_000 * 2 ** failures)
        if (code !== 'rate-limited') failures += 1
        this.o.log.warn(`adapter ${key} failed (${code}); retrying in ${String(wait)} ms`, error)
        await this.o.sleep(wait, signal)
      }
    }
  }

  // ---- event streams ----

  private streamHosts(): Array<string | undefined> {
    const hosts = new Set<string | undefined>([undefined])
    for (const member of this.o.config.members) hosts.add(member.dshRemoteHost)
    for (const live of this.live.values()) hosts.add(live.record.remoteHost)
    return [...hosts]
  }

  private openStream(remote: string | undefined): void {
    const key = remote ?? 'local'
    const mux = this.o.client.openMux({
      remoteHost: remote,
      cursors: { ...this.cursors.get(key) },
      onFrame: delivery => this.onFrame(delivery),
      onCursor: (sessionId, seq) => { this.recordCursor(key, sessionId, seq) },
      onHostRestart: () => { void this.onHostRestart(remote) },
      onState: (state) => { this.muxStates.set(key, state) },
    })
    this.muxes.set(key, mux)
    void mux.whenOpen().then(() => this.catchUp(remote), () => undefined)
  }

  private recordCursor(stream: string, sessionId: string, seq: number): void {
    const cursor = this.cursors.get(stream) ?? {}
    cursor[sessionId] = seq
    this.cursors.set(stream, cursor)
    this.dirtyCursors.add(stream)
    this.cursorTimer ??= setTimeout(() => {
      this.cursorTimer = undefined
      void this.flushCursors()
    }, CURSOR_FLUSH_MS)
    this.cursorTimer.unref()
  }

  private async flushCursors(): Promise<void> {
    if (this.cursorTimer !== undefined) clearTimeout(this.cursorTimer)
    this.cursorTimer = undefined
    const table = this.o.state.table('cursors')
    for (const stream of [...this.dirtyCursors]) {
      this.dirtyCursors.delete(stream)
      try {
        await table.put(stream, { ...this.cursors.get(stream) })
      } catch (error) {
        // Whole-app shutdown disposes sibling plugins concurrently, so the state may already be closed;
        // a lost cursor update only widens the next replay.
        if (!(error instanceof DomainError && error.code === 'closed')) this.o.log.warn(`persisting cursors for ${stream} failed`, error)
      }
    }
  }

  private async onFrame(delivery: MuxDelivery): Promise<void> {
    const { frame, rpcId, remoteHost } = delivery
    switch (frame.type) {
      case 'session/event': {
        const live = this.live.get(frame.sessionId)
        if (live === undefined) return
        await this.applyEvent(live, frame.event)
        return
      }
      case 'approval/requested': return this.interactions.approvalRequested(rpcId, frame, remoteHost)
      case 'approval/resolved': return this.interactions.approvalResolved(frame)
      case 'question/requested': return this.interactions.questionRequested(rpcId, frame, remoteHost)
      case 'question/resolved': return this.interactions.questionResolved(frame)
      /* v8 ignore next 2 -- MuxFrame is a closed union */
      default: return assertNever(frame)
    }
  }

  private async applyEvent(live: LiveSession, event: { type: string; seq: number; time: number; data: unknown }): Promise<void> {
    if (live.applied !== undefined && event.seq <= live.applied) return
    live.applied = event.seq
    try {
      await this.renderer.apply(live, event)
    } catch (error) {
      this.o.log.warn(`rendering ${event.type} for session ${live.record.sessionId} failed`, error)
    }
  }

  private async onHostRestart(remote: string | undefined): Promise<void> {
    await this.interactions.hostRestarted(remote)
    await this.catchUp(remote)
  }

  /** Replay durable history past each session's applied cursor; sessions that never streamed are skipped. */
  private async catchUp(remote: string | undefined): Promise<void> {
    for (const live of this.live.values()) {
      if (live.record.remoteHost !== remote || live.applied === undefined) continue
      try {
        for (;;) {
          const page = await this.o.client.call('session.history', {
            sessionId: live.record.sessionId, afterSeq: live.applied, maxEvents: 200,
          }, remote === undefined ? {} : { remoteHost: remote })
          for (const entry of page.events) await this.applyEvent(live, entry.event)
          if (!page.hasMore || page.events.length === 0) break
        }
      } catch (error) {
        this.o.log.warn(`catching up session ${live.record.sessionId} failed`, error)
      }
    }
  }

  // ---- identity ----

  private actorByKey(key: string): Actor | undefined {
    const split = key.indexOf(':')
    return this.actorFor(key.slice(0, split), key.slice(split + 1))
  }

  private actorFor(platform: string, userId: string): Actor | undefined {
    const { config, state } = this.o
    const owner = config.owners.find(entry => entry.platform === platform && entry.userId === userId)
    if (owner !== undefined) return ownerActor(owner)
    const bound = state.table('members').get(identityKey(platform, userId))
    if (bound?.role === 'owner') return ownerActor({ platform, userId, workspaces: [] })
    const member = config.members.find(entry => entry.platform === platform && (entry.userId === userId || (bound?.role === 'member' && entry.id === bound.memberId)))
    return member === undefined ? undefined : memberActor(member, platform, userId)
  }

  private owners(): OwnerRoute[] {
    const identities = new Map<string, { platform: string; userId: string }>()
    for (const owner of this.o.config.owners) identities.set(identityKey(owner.platform, owner.userId), owner)
    for (const [key, binding] of this.o.state.table('members').entries()) {
      if (binding.role === 'owner') identities.set(key, { platform: key.slice(0, key.indexOf(':')), userId: key.slice(key.indexOf(':') + 1) })
    }
    return [...identities].map(([key, who]) => ({ key, target: this.directTarget(who.platform, who.userId, key) }))
  }

  private directTarget(platform: string, userId: string, key: string): OwnerRoute['target'] {
    const remembered = this.lastBot.get(key)
    const adapter = (remembered === undefined ? undefined : this.o.adapters.get(platform, remembered))
      ?? this.o.adapters.list().find(candidate => candidate.platform === platform)
    const route = adapter?.directRoute(userId)
    return adapter === undefined || route === undefined ? undefined : { platform, botId: adapter.botId, route }
  }

  // ---- inbound ----

  private async inbound(adapter: ChatAdapter, event: ChatInbound): Promise<void> {
    switch (event.type) {
      case 'message': {
        const conversation = conversationKey(adapter.botId, event.route)
        await this.queue.run(conversation, () => this.processMessage(adapter, event, conversation))
        return
      }
      case 'interaction': return this.onInteraction(adapter, event)
      // An edited or deleted message never re-runs or retracts a prompt that was already sent.
      case 'message-edited':
      case 'message-deleted': return
      /* v8 ignore next 2 -- ChatInbound is a closed union */
      default: return assertNever(event)
    }
  }

  private async processMessage(adapter: ChatAdapter, event: MessageEvent, conversation: string): Promise<void> {
    const seenKey = `${adapter.platform}:${adapter.botId}:${event.messageId}`
    const seen = this.o.state.table('seen')
    if (seen.get(seenKey) !== undefined) return
    try {
      await this.admit(adapter, event, conversation)
    } catch (error) {
      this.o.log.warn(`handling message ${seenKey} failed`, error)
      await this.messenger.reply(adapter, event.route, userMessage(error))
    }
    await seen.put(seenKey, Date.now())
    if (seen.size > this.o.config.seenLimit) {
      const oldest = [...seen.entries()]
        .sort((left, right) => left[1] - right[1])
        .slice(0, Math.max(1, Math.floor(this.o.config.seenLimit / 10)))
      for (const [key] of oldest) await seen.delete(key)
    }
  }

  private async admit(adapter: ChatAdapter, event: MessageEvent, conversation: string): Promise<void> {
    if (event.sender.isBot) return
    if (event.route.kind === 'group' && !event.addressed) return
    const parsed = parseInput(event.controlText)
    const actor = this.actorFor(adapter.platform, event.sender.userId)
    if (actor === undefined) return this.unpaired(adapter, event, parsed)
    this.lastBot.set(actor.key, adapter.botId)
    if (event.route.kind === 'group' && this.o.state.table('groups').get(this.groupKey(adapter, event.route)) === undefined
      && !(parsed.kind === 'command' && parsed.name === 'pair-group' && actor.role === 'owner')) return
    const handling: Handling = { adapter, event, actor, conversation }
    switch (parsed.kind) {
      case 'text': {
        if (!actor.commands.has('ask')) return void await this.say(handling, 'You cannot send prompts here.')
        return this.ask(handling, parsed.text, 'queue')
      }
      case 'unknown': return void await this.say(handling, 'Unknown command. Send /help for the list.')
      case 'command': {
        if (parsed.name === 'pair') return void await this.say(handling, 'You are already paired.')
        const denial = authorize(actor, parsed.name)
        if (denial !== undefined) return void await this.say(handling, denial === 'owner-only' ? 'Only an owner can use that command.' : 'That command is not enabled for you.')
        return this.command(handling, parsed.name, parsed.args)
      }
      /* v8 ignore next 2 -- ParsedInput is a closed union */
      default: return assertNever(parsed)
    }
  }

  private groupKey(adapter: ChatAdapter, route: ChatRoute): string {
    return conversationKey(adapter.botId, route)
  }

  private say(handling: Handling, text: string): Promise<unknown> {
    const { adapter, event } = handling
    return this.messenger.reply(adapter, event.route, text, event.route.kind === 'group' ? event.messageId : undefined)
  }

  private async unpaired(adapter: ChatAdapter, event: MessageEvent, parsed: ReturnType<typeof parseInput>): Promise<void> {
    if (event.route.kind !== 'direct') return
    if (parsed.kind === 'command' && parsed.name === 'pair') return this.pair(adapter, event, parsed.args)
    const key = identityKey(adapter.platform, event.sender.userId)
    const last = this.hinted.get(key)
    if (last !== undefined && Date.now() - last < HINT_INTERVAL_MS) return
    this.hinted.set(key, Date.now())
    await this.messenger.reply(adapter, event.route, 'Send /pair <code> to join. Ask an owner for a pairing code.')
  }

  private async pair(adapter: ChatAdapter, event: MessageEvent, code: string): Promise<void> {
    const { config, state } = this.o
    const grant = code === '' ? undefined : await redeemCode(state.table('codes'), code, Date.now())
    const key = identityKey(adapter.platform, event.sender.userId)
    const members = state.table('members')
    const member = grant?.kind === 'member' ? config.members.find(entry => entry.id === grant.memberId) : undefined
    const taken = member !== undefined && [...members.entries()].some(([, binding]) => binding.memberId === member.id)
    if (grant === undefined) {
      await this.messenger.reply(adapter, event.route, 'That pairing code is not valid or has expired.')
    } else if (grant.kind === 'owner') {
      await members.put(key, { role: 'owner', pairedAt: Date.now() })
      this.o.log.info(`chat-bridge: ${key} paired as owner`)
      await this.messenger.reply(adapter, event.route, 'Paired as owner. Send /help for the commands.')
    } else if (member === undefined || member.platform !== adapter.platform || member.userId !== undefined || taken) {
      await this.messenger.reply(adapter, event.route, 'That pairing code cannot be used here.')
    } else {
      await members.put(key, { role: 'member', memberId: member.id, pairedAt: Date.now() })
      this.o.log.info(`chat-bridge: ${key} paired as member ${member.id}`)
      await this.messenger.reply(adapter, event.route, `Paired as ${member.id}. Send /help for the commands.`)
    }
  }

  private async onInteraction(adapter: ChatAdapter, event: InteractionEvent): Promise<void> {
    const actor = this.actorFor(adapter.platform, event.sender.userId)
    if (actor === undefined || event.sender.isBot) return
    const [kind, id, option] = event.actionId.split(':')
    let reply: string | undefined
    if ((kind === 'approve' || kind === 'reject') && id !== undefined) {
      reply = await this.interactions.answerApproval(id, kind === 'approve', actor.key)
    } else if (kind === 'answer' && id !== undefined && option !== undefined && /^\d+$/.test(option)) {
      reply = await this.interactions.answerQuestion(id, { option: Number(option) }, actor.key)
    }
    if (reply !== undefined) await this.messenger.reply(adapter, event.route, reply)
  }

  // ---- commands ----

  private async command(h: Handling, name: Exclude<CommandName, 'pair'>, args: string): Promise<void> {
    const { actor } = h
    switch (name) {
      case 'help': return void await this.say(h, helpText(actor))
      case 'whoami': return void await this.say(h, this.whoami(h))
      case 'status': return void await this.say(h, await this.status(h))
      case 'new': return void await this.say(h, await this.newCommand(h, args))
      case 'ask':
      case 'steer': {
        if (args === '' && h.event.attachments.length === 0) return void await this.say(h, `Send ${name === 'ask' ? '/ask' : '/steer'} <text>.`)
        return this.ask(h, args, name === 'ask' ? 'queue' : 'steer')
      }
      case 'stop': return void await this.say(h, await this.stopTurn(h))
      case 'queue': return void await this.say(h, this.queued(h))
      case 'unqueue': return void await this.say(h, await this.unqueue(h, args))
      case 'sessions': return void await this.say(h, this.sessionList(h))
      case 'session': return void await this.say(h, await this.switchSession(h, args))
      case 'ws': return void await this.say(h, await this.workspace(h, args))
      case 'model': return void await this.say(h, await this.model(h, args))
      case 'title': return void await this.say(h, await this.title(h, args))
      case 'compact':
      case 'plan': return void await this.say(h, await this.slash(h, name, args))
      case 'approve':
      case 'reject': return void await this.say(h, await this.interactions.answerApproval(args.split(/\s+/, 1).join(''), name === 'approve', actor.key))
      case 'answer': return void await this.say(h, await this.answer(h, args))
      case 'invite': return void await this.say(h, await this.invite(args))
      case 'members': return void await this.say(h, this.memberList())
      case 'revoke': return void await this.say(h, await this.revoke(args))
      case 'pair-group': return void await this.say(h, await this.groupCommand(h, true))
      case 'unpair-group': return void await this.say(h, await this.groupCommand(h, false))
      /* v8 ignore next 2 -- CommandName is a closed union */
      default: return assertNever(name)
    }
  }

  private whoami(h: Handling): string {
    const { actor } = h
    const binding = this.o.state.table('bindings').get(h.conversation)
    return [
      `${actor.key} - ${actor.role}${actor.memberId === undefined ? '' : ` ${actor.memberId}`}`,
      `Workspace: ${binding?.workspace ?? actor.workspaces[0] ?? '(default)'}`,
      `Profile: ${actor.agentProfile ?? '(default)'}`,
      `Isolation: ${actor.remoteHost === undefined ? 'this host' : 'remote host'}`,
    ].join('\n')
  }

  private async status(h: Handling): Promise<string> {
    const lines = [...this.adapterStatus].map(([key, status]) => `Platform ${key}: ${status}`)
    for (const [stream, state] of this.muxStates) lines.push(`Harniverse events (${stream}): ${state}`)
    try {
      const host = await this.o.client.describeHost(h.actor.remoteHost === undefined ? {} : { remoteHost: h.actor.remoteHost })
      lines.push(`Harniverse host: boot ${host.bootId}`)
    } catch {
      // The report below says the host is unreachable, which is the whole answer to this probe.
      lines.push('Harniverse host: unreachable')
    }
    const live = this.boundSession(h)
    const latest = live === undefined
      ? undefined
      : [...live.prompts.values()].filter(prompt => prompt.actorKey === h.actor.key && prompt.messageId !== undefined).at(-1)
    if (live !== undefined && latest?.messageId !== undefined) {
      const status = await this.o.client.call('session.workStatus', { sessionId: live.record.sessionId, messageId: latest.messageId }, this.remote(live))
      lines.push(`Last prompt: ${status.status.state}`)
    }
    lines.push(live === undefined ? 'Session: none' : `Session: ...${live.record.sessionId.slice(-8)}${live.turn === undefined ? '' : ' (running)'}`)
    return lines.join('\n')
  }

  private remote(live: LiveSession): { remoteHost?: string } {
    return live.record.remoteHost === undefined ? {} : { remoteHost: live.record.remoteHost }
  }

  private boundSession(h: Handling): LiveSession | undefined {
    const sessionId = this.o.state.table('bindings').get(h.conversation)?.sessionId
    return sessionId === undefined ? undefined : this.live.get(sessionId)
  }

  // ---- sessions ----

  private isolated(h: Handling, record: BridgeSessionRecord): boolean {
    const { actor } = h
    return record.agentProfile === actor.agentProfile && record.remoteHost === actor.remoteHost
      && (record.workspace === undefined || actor.workspaces.includes(record.workspace))
  }

  private async newCommand(h: Handling, profile: string): Promise<string> {
    if (profile !== '' && profile !== h.actor.agentProfile) return 'That profile is not available to you.'
    const live = await this.createSession(h)
    return `Started a new session (...${live.record.sessionId.slice(-8)}).`
  }

  private async createSession(h: Handling): Promise<LiveSession> {
    const { actor, adapter, event } = h
    const { config, state } = this.o
    const bindings = state.table('bindings')
    const previous = bindings.get(h.conversation)
    const workspace = previous?.workspace !== undefined && actor.workspaces.includes(previous.workspace)
      ? previous.workspace
      : actor.workspaces[0]
    // Every alias an actor may use was validated against `workspaceAliases` at load time.
    const aliased = workspace === undefined ? undefined : config.workspaceAliases[workspace]
    const cwd = aliased ?? join(expandHomePath(config.imRoot), actor.role === 'owner' ? 'owner' : join('members', actor.label))
    const sessionId = `chat-${randomUUID()}`
    const record: BridgeSessionRecord = {
      sessionId, ownerKey: actor.key, botId: adapter.botId, platform: adapter.platform,
      route: event.route, cwd, createdAt: Date.now(),
      ...workspace === undefined ? {} : { workspace },
      ...actor.remoteHost === undefined ? {} : { remoteHost: actor.remoteHost },
      ...actor.agentProfile === undefined ? {} : { agentProfile: actor.agentProfile },
    }
    // The bridge state is written before the API call so a crash in between can be replayed with the same id.
    await state.table('sessions').put(sessionId, record)
    await bindings.put(h.conversation, { sessionId, ...workspace === undefined ? {} : { workspace } })
    try {
      await this.o.client.call('session.create', {
        sessionId, cwd, ...actor.agentProfile === undefined ? {} : { agentProfile: actor.agentProfile },
      }, {
        idempotencyKey: this.idempotencyKey(adapter, event.messageId),
        ...actor.remoteHost === undefined ? {} : { remoteHost: actor.remoteHost },
      })
    } catch (error) {
      await state.table('sessions').delete(sessionId)
      if (previous === undefined) await bindings.delete(h.conversation)
      else await bindings.put(h.conversation, previous)
      throw error
    }
    const live = liveSession(record)
    this.live.set(sessionId, live)
    return live
  }

  /** The session this conversation talks to, creating one when none fits. */
  private async sessionFor(h: Handling): Promise<LiveSession> {
    const existing = this.boundSession(h)
    if (existing !== undefined && this.isolated(h, existing.record)) return existing
    if (existing !== undefined && h.event.route.kind === 'group') {
      throw new Error('the group session runs under a different access profile')
    }
    return this.createSession(h)
  }

  private sessionRows(h: Handling): BridgeSessionRecord[] {
    return [...this.live.values()].map(live => live.record)
      .filter(record => h.actor.role === 'owner' || record.ownerKey === h.actor.key)
      .sort((left, right) => right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId))
  }

  private sessionList(h: Handling): string {
    const current = this.o.state.table('bindings').get(h.conversation)?.sessionId
    const rows = this.sessionRows(h).map((record, index) =>
      `${String(index + 1)}. ...${record.sessionId.slice(-8)} ${record.workspace ?? '-'}${record.sessionId === current ? ' (current)' : ''}`)
    return rows.length === 0 ? 'You have no sessions yet.' : rows.join('\n')
  }

  private async switchSession(h: Handling, args: string): Promise<string> {
    const record = this.sessionRows(h)[Number(args) - 1]
    if (!/^\d+$/.test(args) || record === undefined) return 'Send /session <n> with a number from /sessions.'
    if (!this.isolated(h, record) && h.actor.role !== 'owner') return 'That session is not available in this chat.'
    const bindings = this.o.state.table('bindings')
    await bindings.put(h.conversation, { ...bindings.get(h.conversation), sessionId: record.sessionId })
    return `Switched to session ...${record.sessionId.slice(-8)}.`
  }

  private async workspace(h: Handling, alias: string): Promise<string> {
    const { actor } = h
    const bindings = this.o.state.table('bindings')
    if (alias === '') {
      const current = bindings.get(h.conversation)?.workspace ?? actor.workspaces[0]
      return `Workspaces: ${actor.workspaces.length === 0 ? '(none, using the default)' : actor.workspaces.join(', ')}. Current: ${current ?? '(default)'}.`
    }
    if (!actor.workspaces.includes(alias)) return 'That workspace is not available to you.'
    await bindings.put(h.conversation, { ...bindings.get(h.conversation), workspace: alias })
    return `New sessions will use ${alias}. Send /new to start one.`
  }

  private async model(h: Handling, choice: string): Promise<string> {
    const live = this.boundSession(h)
    if (live === undefined) return 'No session yet. Send a message or /new first.'
    const sessionId = live.record.sessionId
    const models = await this.o.client.call('session.models', { sessionId }, this.remote(live))
    const catalog = models.groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`))
    if (choice === '') return `Current: ${models.current.provider}/${models.current.model}\nAvailable: ${catalog.slice(0, 30).join(', ')}`
    const split = choice.indexOf('/')
    if (split <= 0 || !catalog.includes(choice)) return 'Send /model <provider/model> with one of the available models.'
    const picked = await this.o.client.call('session.selectModel', { sessionId, provider: choice.slice(0, split), model: choice.slice(split + 1) },
      { idempotencyKey: this.idempotencyKey(h.adapter, h.event.messageId), ...this.remote(live) })
    return `Model set to ${picked.selected.provider}/${picked.selected.model}.`
  }

  private async title(h: Handling, title: string): Promise<string> {
    const live = this.boundSession(h)
    if (live === undefined) return 'No session yet. Send a message or /new first.'
    if (title === '') return 'Send /title <text>.'
    const renamed = await this.o.client.call('session.rename', { sessionId: live.record.sessionId, title },
      { idempotencyKey: this.idempotencyKey(h.adapter, h.event.messageId), ...this.remote(live) })
    return `Title set to "${renamed.title}".`
  }

  private async slash(h: Handling, name: 'compact' | 'plan', args: string): Promise<string> {
    const live = this.boundSession(h)
    if (live === undefined) return 'No session yet. Send a message or /new first.'
    const line = `/${name}${args === '' ? '' : ` ${args}`}`
    const options = { idempotencyKey: this.idempotencyKey(h.adapter, h.event.messageId), ...this.remote(live) }
    const execution = await this.o.client.typert('commands/execute', { agentId: live.record.sessionId, line, images: [] }, options) as
      { result?: { kind?: string; text?: string } } | undefined
    if (execution === undefined) return 'Harniverse did not recognize that command.'
    return execution.result?.text ?? (execution.result?.kind === 'error' ? 'The command failed.' : 'Done.')
  }

  private async stopTurn(h: Handling): Promise<string> {
    const live = this.boundSession(h)
    if (live === undefined) return 'No session yet.'
    const origin = live.turn?.origin
    if (live.turn === undefined) return 'Nothing is running.'
    if (origin !== undefined && origin.actorKey !== h.actor.key && h.actor.role !== 'owner') {
      return 'Only the person who started this turn, or an owner, can stop it.'
    }
    await this.o.client.call('session.cancel', { sessionId: live.record.sessionId },
      { idempotencyKey: this.idempotencyKey(h.adapter, h.event.messageId), ...this.remote(live) })
    return 'Stopping.'
  }

  private queuedPrompts(h: Handling): Array<{ live: LiveSession; origin: Origin }> {
    const live = this.boundSession(h)
    if (live === undefined) return []
    return [...live.prompts.values()]
      .filter(origin => origin.messageId !== undefined && (h.actor.role === 'owner' || origin.actorKey === h.actor.key))
      .map(origin => ({ live, origin }))
  }

  private queued(h: Handling): string {
    const rows = this.queuedPrompts(h).map(({ origin }, index) => `${String(index + 1)}. [${origin.mode}] ${origin.preview}`)
    return rows.length === 0 ? 'Nothing is queued.' : rows.join('\n')
  }

  private async unqueue(h: Handling, args: string): Promise<string> {
    const rows = this.queuedPrompts(h)
    const picked = args === '' ? rows.at(-1) : rows[Number(args) - 1]
    if (picked === undefined || (args !== '' && !/^\d+$/.test(args))) return 'Nothing to remove. Send /queue to see your queued prompts.'
    await this.o.client.call('session.updateQueue', {
      sessionId: picked.live.record.sessionId, itemId: picked.origin.messageId, action: { kind: 'remove' },
    }, { idempotencyKey: this.idempotencyKey(h.adapter, h.event.messageId), ...this.remote(picked.live) })
    picked.live.prompts.delete(picked.origin.rpcId)
    return 'Removed from the queue.'
  }

  private async answer(h: Handling, args: string): Promise<string> {
    const gap = args.search(/\s/)
    if (gap < 1) return 'Send /answer <id> <answers>.'
    return this.interactions.answerQuestion(args.slice(0, gap), { text: args.slice(gap).trim() }, h.actor.key)
  }

  // ---- owner administration ----

  private async invite(memberId: string): Promise<string> {
    const { config, state } = this.o
    const member = config.members.find(entry => entry.id === memberId)
    if (member === undefined) return 'Send /invite <member> with a configured member id.'
    if (member.userId !== undefined || [...state.table('members').entries()].some(([, binding]) => binding.memberId === member.id)) {
      return `${member.id} is already paired. Use /revoke first to issue a new code.`
    }
    const expiresAt = Date.now() + config.pairing.memberCodeTtlMs
    const code = await issueCode(state.table('codes'), { kind: 'member', memberId: member.id, expiresAt })
    return `Pairing code for ${member.id}: ${code}. It works once and expires in ${String(Math.round(config.pairing.memberCodeTtlMs / 3_600_000 * 10) / 10)} hours. They send it as /pair <code> to this bot in a private chat.`
  }

  private memberList(): string {
    const paired = new Map([...this.o.state.table('members').entries()].flatMap(([key, binding]) => binding.memberId === undefined ? [] : [[binding.memberId, key] as const]))
    const rows = this.o.config.members.map(member =>
      `${member.id} (${member.platform}): ${member.userId !== undefined ? 'static identity' : paired.has(member.id) ? 'paired' : 'not paired'}; ${member.commands.join(',') || 'no commands'}`)
    return rows.length === 0 ? 'No members are configured.' : rows.join('\n')
  }

  private async revoke(memberId: string): Promise<string> {
    const { config, state } = this.o
    const member = config.members.find(entry => entry.id === memberId)
    if (member === undefined) return 'Send /revoke <member> with a configured member id.'
    if (member.userId !== undefined) return `${member.id} is bound in the configuration; edit the configuration to remove them.`
    const members = state.table('members')
    const bound = [...members.entries()].filter(([, binding]) => binding.memberId === member.id)
    if (bound.length === 0) return `${member.id} is not paired.`
    for (const [key] of bound) await members.delete(key)
    return `${member.id} was unbound.`
  }

  private async groupCommand(h: Handling, bind: boolean): Promise<string> {
    if (h.event.route.kind !== 'group') return 'Send this command inside the group chat.'
    const groups = this.o.state.table('groups')
    const key = this.groupKey(h.adapter, h.event.route)
    if (bind) {
      await groups.put(key, { boundBy: h.actor.key, boundAt: Date.now() })
      return 'This group can now talk to the assistant. Mention the bot or reply to it.'
    }
    await groups.delete(key)
    return 'This group is no longer connected.'
  }

  // ---- prompts ----

  private idempotencyKey(adapter: ChatAdapter, messageId: string): string {
    return createHash('sha256').update(`${adapter.platform}:${adapter.botId}:${messageId}`).digest('hex')
  }

  private async ask(h: Handling, text: string, mode: 'queue' | 'steer'): Promise<void> {
    const { actor, adapter, event } = h
    let live: LiveSession | undefined
    if (mode === 'steer') {
      live = this.boundSession(h)
      if (live?.turn === undefined) return void await this.say(h, 'Nothing is running to steer. Send a normal message instead.')
    }
    const content = await this.content(h, text)
    if (content.length === 0) return
    live ??= await this.sessionFor(h)
    const rpcId = randomUUID()
    const origin: Origin = {
      rpcId, actorKey: actor.key, label: actor.label, platform: adapter.platform, botId: adapter.botId,
      route: event.route, mode, preview: truncate(text.replace(/\s+/g, ' '), 40),
    }
    live.prompts.set(rpcId, origin)
    try {
      const accepted = await this.o.client.call('session.prompt', { sessionId: live.record.sessionId, mode, content },
        { rpcId, idempotencyKey: this.idempotencyKey(adapter, event.messageId), ...this.remote(live) })
      origin.messageId = accepted.messageId
      this.o.log.info(`chat-bridge: prompt sender=${actor.key} member=${actor.label} message=${event.messageId} inbox=${accepted.messageId} session=${live.record.sessionId}`)
    } catch (error) {
      live.prompts.delete(rpcId)
      throw error
    }
  }

  private async content(h: Handling, text: string): Promise<Array<Record<string, unknown>>> {
    const { adapter, event, actor } = h
    const parts: Array<Record<string, unknown>> = []
    if (text !== '') {
      parts.push({
        type: 'text',
        text: event.route.kind === 'group' ? withSenderPrefix(adapter.platform, event.sender.displayName ?? event.sender.userId, text) : text,
      })
    }
    const { maxFiles, maxFileBytes, maxInlineImageBytes } = this.o.config.inbound
    if (event.attachments.length > maxFiles) await this.say(h, `Only the first ${String(maxFiles)} attachments were used.`)
    for (const ref of event.attachments.slice(0, maxFiles)) {
      try {
        const { bytes, mediaType } = await this.download(adapter, ref, maxFileBytes)
        if (IMAGE_TYPES.has(mediaType) && bytes.byteLength <= maxInlineImageBytes) {
          parts.push({ type: 'image', mediaType, data: Buffer.from(bytes).toString('base64'), ...ref.name === undefined ? {} : { name: ref.name } })
        } else {
          const stored = await this.o.client.upload(bytes, { ...ref.name === undefined ? {} : { name: ref.name }, mediaType },
            actor.remoteHost === undefined ? {} : { remoteHost: actor.remoteHost })
          parts.push({ type: 'file', attachmentId: stored.attachmentId, bytes: stored.bytes, ...ref.name === undefined ? {} : { name: ref.name }, mediaType })
        }
      } catch (error) {
        this.o.log.warn(`attachment ${ref.attachmentId} could not be used`, error)
        await this.say(h, `Could not use the attachment ${ref.name ?? ref.attachmentId}.`)
      }
    }
    return parts
  }

  private async download(adapter: ChatAdapter, ref: Parameters<ChatAdapter['fetchAttachment']>[0], cap: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; mediaType: string }> {
    const { stream, mediaType } = await adapter.fetchAttachment(ref, cap, AbortSignal.timeout(60_000))
    const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > cap) {
        await reader.cancel()
        throw new Error('attachment exceeds the size limit')
      }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, mediaType }
  }
}
