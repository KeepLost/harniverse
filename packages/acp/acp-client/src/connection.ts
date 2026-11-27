/**
 * The connection: negotiation, handshake, authentication, session and turn
 * routing, and disposal over one agent process. This is the version-neutral
 * core every consumer programs against.
 * @module @deepseek-ai/dsh-acp-client/connection
 */

import type { SubprocessSpawnSpec, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { openBinding, type AcpBinding, type AcpClientInfo, type AcpHandshake, type BindingHandlers } from './binding.ts'
import { AcpError, toAcpError } from './errors.ts'
import { rejectAnswerer } from './permission.ts'
import { selectProfile } from './profile.ts'
import {
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  spawnAcpChild,
  type AcpChild,
} from './transport.ts'
import { toStopReason } from './update.ts'
import type {
  AcpAgentDefinition,
  AcpAgentInfo,
  AcpAgentProfile,
  AcpConnection,
  AcpExit,
  AcpPermissionAnswer,
  AcpPermissionAnswerer,
  AcpPromptBlock,
  AcpPromptOptions,
  AcpProtocol,
  AcpSession,
  AcpSessionInfo,
  AcpTurn,
  AcpTurnEnd,
  AcpUpdate,
} from './types.ts'

/** Identity this client reports at the handshake when the consumer names none. */
export const DEFAULT_CLIENT_INFO: AcpClientInfo = { name: 'harniverse', version: '1.0.0' }

/** What {@link connectAcpAgent} needs. */
export interface AcpConnectOptions {
  readonly definition: AcpAgentDefinition
  /** Absolute working directory of the agent process and of every session it opens. */
  readonly cwd: string
  /** Spawn function of the subprocess seam; the agent rides the seam's scrub and tree-scoped teardown. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Answers the agent's permission requests. Omitted answers decline every request. */
  readonly permission?: AcpPermissionAnswerer
  /** Profiles the consumer supplies, in precedence order. */
  readonly profiles?: readonly AcpAgentProfile[]
  readonly clientInfo?: AcpClientInfo
  readonly disposeEofGraceMs?: number
  readonly disposeGraceMs?: number
  /** Cancels the handshake, the authentication, or the v2-to-v1 fallback; ignored afterwards. */
  readonly signal?: AbortSignal
}

/** One agent process with its binding: the unit the v2-to-v1 fallback replaces. */
interface Attempt {
  readonly child: AcpChild
  readonly binding: AcpBinding
  /** Rejects when the process failed to start or the connection closed. */
  readonly broken: Promise<never>
}

/** The per-session routing state of a connection. */
interface Live {
  /** The turn updates route to: the active one, or a cancelled one until its agent side is quiet. */
  turn: Turn | undefined
  /** A turn waiting for the previous one to go quiet before its prompt is sent. */
  pending: Turn | undefined
}

const CANCELLED: AcpPermissionAnswer = { outcome: { outcome: 'cancelled' } }

/** One prompt exchange: an ordered update stream and its end. */
class Turn implements AcpTurn {
  private readonly queued: AcpUpdate[] = []
  private delivery: PromiseWithResolvers<IteratorResult<AcpUpdate>> | undefined
  private readonly settled = Promise.withResolvers<AcpTurnEnd>()
  private readonly quiet = Promise.withResolvers<void>()
  private finished = false
  readonly end: Promise<AcpTurnEnd> = this.settled.promise
  readonly updates: AsyncIterable<AcpUpdate> = {
    [Symbol.asyncIterator]: () => ({ next: () => this.next() }),
  }

  constructor() {
    // A consumer may read only `updates`; its rejection is then observed here instead of as unhandled.
    void this.end.catch(() => {})
  }

  get isFinished(): boolean {
    return this.finished
  }

  /** Fulfillment means the agent's side is quiet and the session accepts its next prompt. */
  get isQuiet(): Promise<void> {
    return this.quiet.promise
  }

  push(update: AcpUpdate): void {
    if (this.finished) return
    const delivery = this.delivery
    if (delivery === undefined) {
      this.queued.push(update)
      return
    }
    this.delivery = undefined
    delivery.resolve({ value: update, done: false })
  }

  private next(): Promise<IteratorResult<AcpUpdate>> {
    const update = this.queued.shift()
    if (update !== undefined) return Promise.resolve({ value: update, done: false })
    if (this.finished) return Promise.resolve({ value: undefined, done: true })
    return (this.delivery ??= Promise.withResolvers<IteratorResult<AcpUpdate>>()).promise
  }

  private settle(outcome: AcpTurnEnd | AcpError): void {
    if (this.finished) return
    this.finished = true
    this.delivery?.resolve({ value: undefined, done: true })
    if (outcome instanceof AcpError) this.settled.reject(outcome)
    else this.settled.resolve(outcome)
  }

  finish(end: AcpTurnEnd): void {
    this.settle(end)
  }

  fail(error: AcpError): void {
    this.settle(error)
  }

  markQuiet(): void {
    this.quiet.resolve()
  }
}

function openAttempt(options: AcpConnectOptions, version: AcpProtocol, handlers: BindingHandlers): Attempt {
  const child = spawnAcpChild({
    definition: options.definition,
    cwd: options.cwd,
    spawn: options.spawn,
    disposeEofGraceMs: options.disposeEofGraceMs ?? DEFAULT_DISPOSE_EOF_GRACE_MS,
    disposeGraceMs: options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  })
  const binding = openBinding(version, child.io, options.cwd, options.clientInfo ?? DEFAULT_CLIENT_INFO, handlers)
  const broken = Promise.race([
    child.failed,
    binding.closed.then((): never => { throw new AcpError('transport', 'the agent closed the connection') }),
  ])
  // Every guarded operation and the close watcher observe this rejection.
  void broken.catch(observeIgnored)
  return { child, binding, broken }
}

/**
 * Observe a rejection nobody can act on: a best-effort message to an agent
 * that is already gone, or a failure another owner reports. Observing it here
 * keeps it from surfacing as unhandled.
 */
function observeIgnored(): void {}

/** The setup failure a cancelled handshake, authentication, or fallback rejects with. */
function abortError(): AcpError {
  return new AcpError('transport', 'the connection setup was cancelled')
}

/** Await one setup step, or fail as soon as the connection breaks or `signal` aborts. */
async function settleSetup<T>(
  attempt: Attempt,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  // The signal's promise joins the race only when it can reject; without a
  // signal it stays pending and the race ignores it.
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(abortError()) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([operation(), attempt.broken, aborted.promise])
  } catch (error: unknown) {
    throw toAcpError('protocol', error)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function release(attempt: Attempt): Promise<void> {
  attempt.binding.close()
  await attempt.child.dispose()
}

/** Complete the one authentication flow this client can drive. */
async function authenticate(attempt: Attempt, handshake: AcpHandshake, signal: AbortSignal | undefined): Promise<void> {
  const method = handshake.authMethods.find(candidate => !candidate.terminal)
  if (method === undefined) {
    throw new AcpError('auth', `the agent only offers interactive terminal sign-in (${handshake.authMethods.map(candidate => candidate.id).join(', ')}); sign in with the agent's own program once, outside the harness`)
  }
  await settleSetup(attempt, signal, () => attempt.binding.authenticate(method.id))
}

/** One connected agent process. */
class Connection implements AcpConnection {
  private closed = false
  private readonly sessions = new Map<string, Live>()
  private readonly handles = new Map<string, AcpSession>()
  private disposal: Promise<void> | undefined
  readonly exited: Promise<AcpExit>

  private constructor(
    private readonly attempt: Attempt,
    readonly protocol: AcpProtocol,
    readonly agent: AcpAgentInfo,
  ) {
    this.exited = attempt.child.exited.then(outcome => ({ exitCode: outcome.exitCode, signal: outcome.signal }))
    void attempt.broken.then(undefined, (error: unknown) => { this.fail(toAcpError('transport', error)) })
  }

  /** Negotiate, authenticate, and return the live connection; every failure reaps what it started. */
  static async open(options: AcpConnectOptions): Promise<AcpConnection> {
    // Nothing starts for a setup that is already cancelled, or for a pinned
    // profile nobody supplied: both are known before any process exists.
    const start = (version: AcpProtocol): Attempt => {
      if (options.signal?.aborted === true) throw abortError()
      return openAttempt(options, version, handlers)
    }
    const pinned = selectProfile({ profiles: options.profiles, pinned: options.definition.profile, agentName: undefined })
    const requested = options.definition.protocol ?? 1
    let answerer: AcpPermissionAnswerer = rejectAnswerer
    let target: Connection | undefined
    const handlers: BindingHandlers = {
      update: (sessionId, update) => {
        // Only a session this client opened can receive updates, which requires the connection to exist.
        /* v8 ignore next -- an agent cannot route updates before it answered initialize */
        target?.route(sessionId, update)
      },
      permission: request => Promise.resolve().then(() => answerer(request)).catch(() => CANCELLED),
    }
    let attempt = start(requested)
    try {
      let handshake = await settleSetup(attempt, options.signal, () => attempt.binding.initialize(pinned?.customize))
      if (requested === 2 && handshake.protocolVersion === 1) {
        await release(attempt)
        attempt = start(1)
        handshake = await settleSetup(attempt, options.signal, () => attempt.binding.initialize(pinned?.customize))
      }
      if (handshake.protocolVersion !== attempt.binding.version) {
        throw new AcpError('handshake', `the agent speaks ACP version ${handshake.protocolVersion}; this client speaks versions 1 and 2`)
      }
      const profile = selectProfile({ profiles: options.profiles, pinned: options.definition.profile, agentName: handshake.name })
      attempt.binding.use(profile?.customize)
      if (handshake.authMethods.length > 0) await authenticate(attempt, handshake, options.signal)
      const connection = new Connection(
        attempt,
        attempt.binding.version,
        {
          ...handshake.name === undefined ? {} : { name: handshake.name },
          ...handshake.version === undefined ? {} : { version: handshake.version },
          capabilities: handshake.capabilities,
        },
      )
      target = connection
      answerer = options.permission ?? rejectAnswerer
      return connection
    } catch (error: unknown) {
      await release(attempt)
      throw toAcpError('protocol', error)
    }
  }

  private route(sessionId: string, update: AcpUpdate): void {
    this.sessions.get(sessionId)?.turn?.push(update)
  }

  /** End every active turn with `error` and stop admitting work. Idempotent. */
  private fail(error: AcpError): void {
    this.closed = true
    for (const live of this.sessions.values()) live.turn?.fail(error)
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new AcpError('transport', 'the agent connection is closed')
    try {
      return await Promise.race([operation(), this.attempt.broken])
    } catch (error: unknown) {
      throw toAcpError('protocol', error)
    }
  }

  private session(sessionId: string): AcpSession {
    const existing = this.handles.get(sessionId)
    if (existing !== undefined) return existing
    const live = this.sessions.get(sessionId) ?? { turn: undefined, pending: undefined }
    this.sessions.set(sessionId, live)
    const handle: AcpSession = {
      sessionId,
      prompt: (prompt, promptOptions) => this.openTurn(live, sessionId, prompt, promptOptions),
      cancel: () => this.guard(() => this.attempt.binding.cancel(sessionId)),
    }
    this.handles.set(sessionId, handle)
    return handle
  }

  private openTurn(
    live: Live,
    sessionId: string,
    prompt: readonly AcpPromptBlock[],
    options: AcpPromptOptions | undefined,
  ): AcpTurn {
    const turn = new Turn()
    if (this.closed) {
      turn.fail(new AcpError('transport', 'the agent connection is closed'))
      return turn
    }
    const previous = live.turn
    const waiting = live.pending
    if ((previous !== undefined && !previous.isFinished) || (waiting !== undefined && !waiting.isFinished)) {
      turn.fail(new AcpError('protocol', `a prompt is already active on session "${sessionId}"`))
      return turn
    }
    live.pending = turn
    const signal = options?.signal
    const onAbort = (): void => {
      // Best effort: the agent may be gone; the local cancellation stands either way.
      void this.attempt.binding.cancel(sessionId).catch(observeIgnored)
      turn.finish({ stopReason: 'cancelled' })
    }
    if (signal?.aborted === true) {
      turn.finish({ stopReason: 'cancelled' })
      live.pending = undefined
      turn.markQuiet()
      return turn
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void (async (): Promise<void> => {
      try {
        // The previous turn keeps receiving its prompt's late updates until the
        // agent is quiet, so they never leak into this one.
        if (previous !== undefined) await previous.isQuiet
        // A turn cancelled while it waited, or replaced by a newer one, sends nothing.
        if (live.pending !== turn || turn.isFinished) return
        live.turn = turn
        live.pending = undefined
        const end = await Promise.race([this.attempt.binding.prompt(sessionId, prompt), this.attempt.broken])
        turn.finish({ stopReason: toStopReason(end.stopReason), ...end.error === undefined ? {} : { error: end.error } })
      } catch (error: unknown) {
        turn.fail(toAcpError('protocol', error))
      } finally {
        signal?.removeEventListener('abort', onAbort)
        if (live.turn === turn) live.turn = undefined
        turn.markQuiet()
      }
    })()
    return turn
  }

  newSession(): Promise<AcpSession> {
    return this.guard(() => this.attempt.binding.newSession()).then(sessionId => this.session(sessionId))
  }

  async resumeSession(sessionId: string): Promise<AcpSession> {
    if (!this.agent.capabilities.resume) {
      throw new AcpError('unsupported', 'the agent did not advertise session resume')
    }
    await this.guard(() => this.attempt.binding.resumeSession(sessionId))
    return this.session(sessionId)
  }

  async listSessions(): Promise<readonly AcpSessionInfo[]> {
    if (!this.agent.capabilities.list) {
      throw new AcpError('unsupported', 'the agent did not advertise session listing')
    }
    return this.guard(() => this.attempt.binding.listSessions())
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.agent.capabilities.close) {
      throw new AcpError('unsupported', 'the agent did not advertise session close')
    }
    await this.guard(() => this.attempt.binding.closeSession(sessionId))
    this.sessions.delete(sessionId)
    this.handles.delete(sessionId)
  }

  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.fail(new AcpError('transport', 'the agent connection was disposed'))
      this.attempt.binding.close()
      await this.attempt.child.dispose()
    })())
  }
}

/**
 * Start one external agent, negotiate the protocol, authenticate, and return
 * the live connection. Any failure, including a cancelled setup, rejects with
 * an `AcpError` after the process it started is reaped.
 * @param options - the agent definition, the seam's spawn function, the
 *   working directory, the permission answerer, and the teardown graces.
 * @returns the connected agent.
 */
export async function connectAcpAgent(options: AcpConnectOptions): Promise<AcpConnection> {
  return Connection.open(options)
}
