/**
 * The connection: negotiation, handshake, sign-in on the agent's demand,
 * session and turn routing, session options, and disposal over one agent
 * process. This is the version-neutral core every consumer programs against.
 * @module @deepseek-ai/dsh-acp-client/connection
 */

import type { SubprocessSpawnSpec, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  openBinding,
  type AcpBinding,
  type AcpClientCapabilities,
  type AcpClientInfo,
  type AcpSessionSetup,
  type RawTurnEnd,
  type BindingHandlers,
} from './binding.ts'
import { AcpError, isAcpAuthRequired, toAcpError } from './errors.ts'
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
  AcpCapabilities,
  AcpCommand,
  AcpConfigOption,
  AcpConfigValue,
  AcpConnection,
  AcpExit,
  AcpPermissionAnswer,
  AcpPermissionAnswerer,
  AcpPromptBlock,
  AcpPromptOptions,
  AcpProtocol,
  AcpQuestionAnswer,
  AcpQuestionAnswerer,
  AcpSession,
  AcpSessionInfo,
  AcpSessionModes,
  AcpSessionRequestOptions,
  AcpSignInHooks,
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
  /** Answers the agent's questions. Omitted declines every question. */
  readonly questions?: AcpQuestionAnswerer
  /** What to do for the person while the agent waits for its sign-in. */
  readonly signIn?: AcpSignInHooks
  /** Profiles the consumer supplies, in precedence order. */
  readonly profiles?: readonly AcpAgentProfile[]
  readonly clientInfo?: AcpClientInfo
  readonly disposeEofGraceMs?: number
  readonly disposeGraceMs?: number
  /** Cancels the handshake or the v2-to-v1 fallback; ignored afterwards. */
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
  /** The options the agent last reported for the session. */
  modes: AcpSessionModes | undefined
  configOptions: readonly AcpConfigOption[] | undefined
  commands: readonly AcpCommand[] | undefined
}

const CANCELLED: AcpPermissionAnswer = { outcome: { outcome: 'cancelled' } }
const DECLINE: AcpQuestionAnswer = { action: 'decline' }
const CANCEL_QUESTION: AcpQuestionAnswer = { action: 'cancel' }

/** A browser address inside one line of the agent's diagnostics. */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g

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

function openAttempt(
  options: AcpConnectOptions,
  version: AcpProtocol,
  capabilities: AcpClientCapabilities,
  handlers: BindingHandlers,
): Attempt {
  const child = spawnAcpChild({
    definition: options.definition,
    cwd: options.cwd,
    spawn: options.spawn,
    disposeEofGraceMs: options.disposeEofGraceMs ?? DEFAULT_DISPOSE_EOF_GRACE_MS,
    disposeGraceMs: options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  })
  const binding = openBinding(version, child.io, options.cwd, options.clientInfo ?? DEFAULT_CLIENT_INFO, capabilities, handlers)
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

/** The setup failure a cancelled handshake, sign-in, or fallback rejects with. */
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

/**
 * Report every browser address the agent prints, once each, until the sign-in
 * ends. A consumer that shows none is not called.
 * @param diagnostics - the agent's stderr.
 * @param report - where an address goes.
 * @returns what stops the watch.
 */
function watchUrls(diagnostics: AsyncIterable<string>, report: ((url: string) => void) | undefined): () => void {
  if (report === undefined) {
    /* v8 ignore next -- a connection without the hook never starts a watch */
    return () => {}
  }
  const stopped = new AbortController()
  const seen = new Set<string>()
  void (async (): Promise<void> => {
    for await (const line of diagnostics) {
      if (stopped.signal.aborted) return
      for (const match of line.matchAll(URL_PATTERN)) {
        if (seen.has(match[0])) continue
        seen.add(match[0])
        report(match[0])
      }
    }
  })().catch(() => {
    // The diagnostics ended or have a reader; the sign-in reports its own outcome.
  })
  return () => { stopped.abort() }
}

/** The modes with another one in effect; a report before any offered list names no available mode. */
function withCurrentMode(modes: AcpSessionModes | undefined, currentModeId: string): AcpSessionModes {
  return modes === undefined ? { current: currentModeId, available: [] } : { ...modes, current: currentModeId }
}

/** Fold what one setup response reported into the session's state. */
function applySetup(live: Live, setup: AcpSessionSetup): void {
  if (setup.modes !== undefined) live.modes = setup.modes
  if (setup.configOptions !== undefined) live.configOptions = setup.configOptions
}

/** The first prompt block the agent's handshake did not admit, when there is one. */
function refusedBlock(prompt: readonly AcpPromptBlock[], capabilities: AcpCapabilities['prompt']): AcpPromptBlock | undefined {
  return prompt.find(block => block.type !== 'text' && !capabilities[block.type])
}

/** One connected agent process. */
class Connection implements AcpConnection {
  private closed = false
  private readonly sessions = new Map<string, Live>()
  private readonly handles = new Map<string, AcpSession>()
  private disposal: Promise<void> | undefined
  /** The sign-in this connection is completing, shared by every request that demands it. */
  private signingIn: Promise<void> | undefined
  readonly exited: Promise<AcpExit>

  private constructor(
    private readonly attempt: Attempt,
    private readonly definition: AcpAgentDefinition,
    private readonly hooks: AcpSignInHooks | undefined,
    readonly protocol: AcpProtocol,
    readonly agent: AcpAgentInfo,
  ) {
    this.exited = attempt.child.exited.then(outcome => ({ exitCode: outcome.exitCode, signal: outcome.signal }))
    void attempt.broken.then(undefined, (error: unknown) => { this.fail(toAcpError('transport', error)) })
  }

  /** Negotiate and return the live connection; every failure reaps what it started. */
  static async open(options: AcpConnectOptions): Promise<AcpConnection> {
    // Nothing starts for a setup that is already cancelled, or for a pinned
    // profile nobody supplied: both are known before any process exists.
    const capabilities: AcpClientCapabilities = {
      elicitation: options.questions !== undefined,
      terminalAuth: options.signIn?.terminal !== undefined,
    }
    const start = (version: AcpProtocol): Attempt => {
      if (options.signal?.aborted === true) throw abortError()
      return openAttempt(options, version, capabilities, handlers)
    }
    const pinned = selectProfile({ profiles: options.profiles, pinned: options.definition.profile, agentName: undefined })
    const requested = options.definition.protocol ?? 1
    let answerer: AcpPermissionAnswerer = rejectAnswerer
    let questioner: AcpQuestionAnswerer = declineAnswerer
    let target: Connection | undefined
    const handlers: BindingHandlers = {
      update: (sessionId, update) => {
        // Only a session this client opened can receive updates, which requires the connection to exist.
        /* v8 ignore next -- an agent cannot route updates before it answered initialize */
        target?.route(sessionId, update)
      },
      permission: request => Promise.resolve().then(() => answerer(request)).catch(() => CANCELLED),
      question: request => Promise.resolve().then(() => questioner(request)).catch(() => CANCEL_QUESTION),
      link: (url) => {
        // The hook is read once, so a consumer that shows nothing reports exactly that.
        const show = options.signIn?.url
        if (show === undefined) return false
        show(url)
        return true
      },
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
      // Sign-in waits for the agent to demand it: one that is already signed in never asks.
      const connection = new Connection(
        attempt,
        options.definition,
        options.signIn,
        attempt.binding.version,
        {
          ...handshake.name === undefined ? {} : { name: handshake.name },
          ...handshake.version === undefined ? {} : { version: handshake.version },
          capabilities: handshake.capabilities,
          authMethods: handshake.authMethods,
        },
      )
      target = connection
      answerer = options.permission ?? rejectAnswerer
      questioner = options.questions ?? declineAnswerer
      return connection
    } catch (error: unknown) {
      await release(attempt)
      throw toAcpError('protocol', error)
    }
  }

  private route(sessionId: string, update: AcpUpdate): void {
    const live = this.sessions.get(sessionId)
    if (live === undefined) return
    switch (update.kind) {
      case 'mode':
        live.modes = withCurrentMode(live.modes, update.currentModeId)
        break
      case 'config':
        live.configOptions = update.configOptions
        break
      case 'commands':
        live.commands = update.commands
        break
      default:
        break
    }
    live.turn?.push(update)
  }

  /** End every active turn with `error` and stop admitting work. Idempotent. */
  private fail(error: AcpError): void {
    this.closed = true
    for (const live of this.sessions.values()) live.turn?.fail(error)
  }

  /** Run one agent request, or fail as soon as the connection closes or `signal` aborts. */
  private async guard<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new AcpError('transport', 'the agent connection is closed')
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => { aborted.reject(abortError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([operation(), this.attempt.broken, aborted.promise])
    } catch (error: unknown) {
      throw toAcpError('protocol', error)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Run one agent request, and complete the agent's sign-in first when it
   * refuses the request until a person signs in. The wait for the answer and
   * the sign-in both end when `signal` aborts.
   */
  private authenticated<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.run(operation, signal, true)
  }

  /**
   * Run one prompt, and complete the agent's sign-in first when the agent
   * refuses it until a person signs in. Only the sign-in waits on `signal`:
   * a cancelled turn keeps receiving its prompt's answer, because the agent
   * is not quiet until it gives one.
   */
  private prompted(prompt: () => Promise<RawTurnEnd>, signal?: AbortSignal): Promise<RawTurnEnd> {
    return this.run(prompt, signal, false)
  }

  private async run<T>(operation: () => Promise<T>, signal: AbortSignal | undefined, cancellable: boolean): Promise<T> {
    try {
      return await (cancellable ? this.guard(operation, signal) : this.guard(operation))
    } catch (error: unknown) {
      if (!isAcpAuthRequired(error)) throw error
      await this.signIn(signal)
      return cancellable ? this.guard(operation, signal) : this.guard(operation)
    }
  }

  /**
   * The sign-in every request refused at the same moment joins. One that
   * fails is not kept: the next refusal starts a fresh attempt.
   */
  private signIn(signal: AbortSignal | undefined): Promise<void> {
    const attempt = this.signingIn ?? this.runSignIn(signal).then(
      () => { this.signingIn = undefined },
      (error: unknown) => {
        this.signingIn = undefined
        throw error
      },
    )
    this.signingIn = attempt
    return attempt
  }

  private async runSignIn(signal: AbortSignal | undefined): Promise<void> {
    const methods = this.agent.authMethods
    const method = methods.find(candidate => candidate.id === this.definition.authMethod)
      ?? methods.find(candidate => candidate.kind === 'agent')
      ?? methods[0]
    if (method === undefined) {
      throw new AcpError('auth', 'the agent requires sign-in and offers no method here; complete its sign-in once with the agent\'s own program, outside the harness')
    }
    if (method.kind === 'terminal') {
      const args = [...(this.definition.args ?? []), ...(method.args ?? [])]
      const terminal = this.hooks?.terminal
      if (terminal === undefined) {
        throw new AcpError('auth', `the agent only offers interactive terminal sign-in (${methods.map(candidate => candidate.id).join(', ')}); run \`${[this.definition.command, ...args].join(' ')}\` once, outside the harness`)
      }
      const completed = await settleSetup(this.attempt, signal, () => terminal({ method, command: this.definition.command, args }, signal))
      if (!completed) throw new AcpError('auth', `the terminal sign-in "${method.name}" was not completed`)
      return
    }
    const stop = watchUrls(this.attempt.child.diagnostics, this.hooks?.url)
    try {
      await settleSetup(this.attempt, signal, () => this.attempt.binding.authenticate(method.id))
    } finally {
      stop()
    }
  }

  private session(sessionId: string, setup: AcpSessionSetup = {}): AcpSession {
    const live = this.live(sessionId)
    applySetup(live, setup)
    const existing = this.handles.get(sessionId)
    if (existing !== undefined) return existing
    const handle: AcpSession = {
      sessionId,
      get modes(): AcpSessionModes | undefined { return live.modes },
      get configOptions(): readonly AcpConfigOption[] | undefined { return live.configOptions },
      get commands(): readonly AcpCommand[] | undefined { return live.commands },
      prompt: (prompt, promptOptions) => this.openTurn(live, sessionId, prompt, promptOptions),
      cancel: () => this.guard(() => this.attempt.binding.cancel(sessionId)),
      setMode: (modeId, options) => this.setMode(live, sessionId, modeId, options),
      setConfigOption: (configId, value, options) => this.setConfigOption(live, sessionId, configId, value, options),
    }
    this.handles.set(sessionId, handle)
    return handle
  }

  /** The routing state of one session, created on first use. */
  private live(sessionId: string): Live {
    let live = this.sessions.get(sessionId)
    if (live === undefined) {
      live = { turn: undefined, pending: undefined, modes: undefined, configOptions: undefined, commands: undefined }
      this.sessions.set(sessionId, live)
    }
    return live
  }

  private async setMode(
    live: Live,
    sessionId: string,
    modeId: string,
    options: AcpSessionRequestOptions | undefined,
  ): Promise<AcpSessionModes> {
    await this.authenticated(() => this.attempt.binding.setMode(sessionId, modeId), options?.signal)
    live.modes = withCurrentMode(live.modes, modeId)
    return live.modes
  }

  private async setConfigOption(
    live: Live,
    sessionId: string,
    configId: string,
    value: AcpConfigValue,
    options: AcpSessionRequestOptions | undefined,
  ): Promise<readonly AcpConfigOption[]> {
    const setup = await this.authenticated(() => this.attempt.binding.setConfigOption(sessionId, configId, value), options?.signal)
    applySetup(live, setup)
    return live.configOptions ?? []
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
    // A block the agent cannot take ends the turn before it opens, so nothing is sent on its behalf.
    const refused = refusedBlock(prompt, this.agent.capabilities.prompt)
    if (refused !== undefined) {
      turn.fail(new AcpError('unsupported', `the agent did not advertise ${refused.type} prompts`))
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
        // A sign-in the agent demands here keeps the turn open until it is completed.
        const end = await this.prompted(() => this.attempt.binding.prompt(sessionId, prompt), signal)
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

  async newSession(options?: AcpSessionRequestOptions): Promise<AcpSession> {
    const { sessionId, ...setup } = await this.authenticated(() => this.attempt.binding.newSession(), options?.signal)
    return this.session(sessionId, setup)
  }

  async resumeSession(sessionId: string, options?: AcpSessionRequestOptions): Promise<AcpSession> {
    if (!this.agent.capabilities.resume) {
      throw new AcpError('unsupported', 'the agent did not advertise session resume')
    }
    const setup = await this.authenticated(() => this.attempt.binding.resumeSession(sessionId), options?.signal)
    return this.session(sessionId, setup)
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

/** Answers every question with a refusal; the default of a connection whose consumer asks nothing. */
const declineAnswerer: AcpQuestionAnswerer = () => DECLINE

/**
 * Start one external agent and negotiate the protocol. Sign-in waits for the
 * agent to demand it. Any failure, including a cancelled setup, rejects with
 * an `AcpError` after the process it started is reaped.
 * @param options - the agent definition, the seam's spawn function, the
 *   working directory, the permission and question answerers, the sign-in
 *   hooks, and the teardown graces.
 * @returns the connected agent.
 */
export async function connectAcpAgent(options: AcpConnectOptions): Promise<AcpConnection> {
  return Connection.open(options)
}
