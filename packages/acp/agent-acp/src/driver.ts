/**
 * The ACP step driver: each step is one segment of an external agent's turn,
 * written into the session log in the shape the model loop produces. A
 * segment ends when the external agent speaks again after its tool calls all
 * reported, or when its turn ends; the machine then opens the next step.
 * @module @deepseek-ai/dsh-agent-acp/driver
 */

import type { AgentHost, StepDriver, StepEndReason, StepPosition } from '@deepseek-ai/dsh-agent'
import { allowAnswer, connectAcpAgent, isAcpError, isAcpNotFound } from '@deepseek-ai/dsh-acp-client'
import type {
  AcpAgentDefinition,
  AcpCommand,
  AcpConfigOption,
  AcpConfigValue,
  AcpConnection,
  AcpContentBlock,
  AcpPermissionAnswer,
  AcpPermissionAnswerer,
  AcpPermissionRequest,
  AcpPromptBlock,
  AcpProtocol,
  AcpQuestionAnswer,
  AcpQuestionAnswerer,
  AcpQuestionRequest,
  AcpQuestionValue,
  AcpSession,
  AcpSessionModes,
  AcpSignInHooks,
  AcpToolCallPatch,
  AcpTurnEnd,
  AcpUpdate,
} from '@deepseek-ai/dsh-acp-client'
import {
  BlockAssembler,
  boundContextSummary,
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  errorChain,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SubprocessSpawnSpec, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
// Type-only: resolves the `sessionTitle` service this driver reads through `ctx.get`.
import type {} from '@deepseek-ai/dsh-session-title'
// Type-only: resolves the `approval` service the permission answerer reads through `ctx.get`.
import type {} from '@deepseek-ai/dsh-user-approval'
import { planTodos } from './plan.ts'
import { recordedBinding, type AcpSessionEventData } from './session.ts'

/** How the driver answers the external agent's permission requests. */
export type AcpPermissionMode = 'ask' | 'allow' | 'reject'

/** What the plugin resolved for one agent's driver. */
export interface AcpDriverOptions {
  readonly definition: AcpAgentDefinition
  /** Working directory of the external process; the session's own when omitted. */
  readonly cwd: string | undefined
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly permission: AcpPermissionAnswerer
  /** Asks the person what the agent wants to know; omitted declines every question. */
  readonly questions?: AcpQuestionAnswerer
  /** Asks the person to complete a terminal sign-in; omitted refuses one. */
  readonly terminalSignIn?: AcpSignInHooks['terminal']
  /** Resolves the credential-backed environment of one start; a resolved value is never kept. */
  readonly resolveEnv?: () => Promise<Record<string, string>>
  /** Whether a reopened session reattaches to the external session its own log records. */
  readonly resume: boolean
}

/** What the `acp` commands read and switch on a driven session. */
export interface AcpDriverView {
  /** The agent's reported name once the handshake told it, and its command before that. */
  readonly agent: string
  readonly protocol: AcpProtocol | undefined
  /** The external session in effect and how it was reached; absent until a turn opened one. */
  readonly session: { readonly id: string; readonly reached: 'new' | 'resumed' } | undefined
  readonly modes: AcpSessionModes | undefined
  readonly configOptions: readonly AcpConfigOption[] | undefined
  readonly commands: readonly AcpCommand[] | undefined
  /** Switch the session's mode.
   * @param modeId - one of the offered modes.
   */
  setMode(modeId: string): Promise<void>
  /** Set one configuration option.
   * @param configId - one of the offered options.
   * @param value - a value that option accepts.
   */
  setConfigOption(configId: string, value: AcpConfigValue): Promise<void>
}

/** The name the question the agent asked is recorded under, beside its tool calls. */
const QUESTION_TOOL = 'acp_question'

/** The external turn the steps of one harness turn read from. */
interface Exchange {
  readonly iterator: AsyncIterator<AcpUpdate>
  readonly end: Promise<AcpTurnEnd>
  /** The update that closed the previous segment and opens the next one. */
  held: AcpUpdate | undefined
}

/** One tool call the segment's message carries. */
interface SegmentCall {
  readonly callId: CallId
  readonly name: string
  /** Raw input as JSON text, or the agent's title when it published no input. */
  arguments: string
  /** The agent's latest title for the call, when it published one. */
  title: string | undefined
  completion: AcpToolCallPatch | undefined
}

/** Which stream block the segment is writing into. */
type BlockType = 'text' | 'reasoning'

const FAILURE_CODE = 'ACP_TURN'
const DECLINE: AcpQuestionAnswer = { action: 'decline' }

function text(content: AcpContentBlock): string | undefined {
  return content.type === 'text' && typeof content.text === 'string' ? content.text : undefined
}

/**
 * Prompt blocks for the step's input: the text of what the person wrote.
 * Context that harness plugins inject is left out, because the external agent
 * owns its own context; a step without person-written text sends a placeholder.
 * @param messages - the messages the machine entered for this step.
 * @returns the text blocks the external agent receives.
 */
function promptBlocks(messages: readonly UserMessage[]): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim() !== '') blocks.push({ type: 'text', text: block.text })
    }
  }
  return blocks.length === 0 ? [{ type: 'text', text: '(no text content)' }] : blocks
}

/** The text a tool call reported, as the content of its model-facing result. */
function resultContent(call: SegmentCall): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const item of call.completion?.content ?? []) {
    const block: unknown = item.type === 'content' ? item.content : undefined
    const value = typeof block === 'object' && block !== null ? text(block as AcpContentBlock) : undefined
    if (value !== undefined) blocks.push({ type: 'text', text: value })
  }
  return blocks.length === 0 ? [{ type: 'text', text: call.title ?? '' }] : blocks
}

/**
 * Express an ACP failure as the structured error a turn ending records.
 * @param error - what the client core or the external agent reported.
 * @returns the error the machine records.
 */
function toFailure(error: unknown): Error {
  if (error instanceof LlmError) return error
  const message = errorChain(error)
  const kind = isAcpError(error) ? error.kind : 'protocol'
  return new LlmError(`the external agent failed (${kind}): ${message}`, FAILURE_CODE, { cause: error })
}

/**
 * Answer every permission request with the plugin's configured mode. `ask`
 * routes through the approval seam, which fails closed without an answerer.
 * @param mode - `ask`, `allow`, or `reject`.
 * @param host - the agent whose session receives the approval audit.
 * @returns the answerer the connection uses.
 */
export function permissionAnswerer(mode: AcpPermissionMode, host: AgentHost): AcpPermissionAnswerer {
  return async (request: AcpPermissionRequest): Promise<AcpPermissionAnswer> => {
    if (mode === 'reject') return { outcome: { outcome: 'cancelled' } }
    if (mode === 'allow') return allowAnswer(request)
    const approval = host.ownerCtx.get('approval')
    if (approval === undefined) return { outcome: { outcome: 'cancelled' } }
    const callId = request.toolCallId === undefined ? undefined : CallId(request.toolCallId)
    const outcome = await approval.request({
      agent: host.agent,
      toolName: request.title === undefined || request.title === '' ? 'an external tool' : request.title,
      ...callId === undefined ? {} : { callId },
      ...request.reason === undefined ? {} : { reason: request.reason },
      signal: request.signal,
    })
    return outcome === 'allowed-once' ? allowAnswer(request) : { outcome: { outcome: 'cancelled' } }
  }
}

/**
 * Drives an agent through an external ACP agent. The connection opens at the
 * first step and lives until the agent's scope unwinds, which reaps the
 * external process. The external session is recorded in the session log, so
 * a reopened harness session reattaches to it while the agent still holds it.
 */
export class AcpStepDriver implements StepDriver<void> {
  private connection: AcpConnection | undefined
  private connecting: Promise<AcpConnection> | undefined
  private session: AcpSession | undefined
  private exchange: Exchange | undefined
  /** The segment the running step writes, where a question the agent asks is recorded. */
  private segment: Segment | undefined
  /** The external session in effect and how it was reached. */
  private binding: AcpDriverView['session']
  /** The title this driver applied last, which a later report by the agent may replace. */
  private appliedTitle: string | undefined
  private readonly signIn: AcpSignInHooks

  constructor(
    private readonly host: AgentHost,
    private readonly options: AcpDriverOptions,
  ) {
    // The external process lives exactly as long as this agent.
    host.ctx.effect(() => () => this.close(), 'agent-acp.connection()')
    const terminal = options.terminalSignIn
    this.signIn = {
      url: (url) => { this.link(url) },
      ...terminal === undefined ? {} : { terminal: (signIn, signal) => terminal(signIn, signal) },
    }
  }

  /** The external agent needs no per-step preparation. */
  prepare(): Promise<void> {
    return Promise.resolve()
  }

  /** What the `acp` commands read and switch; every field reads the session as it stands now. */
  view(): AcpDriverView {
    const connection = this.connection
    const current = (): AcpSession | undefined => this.session
    const binding = (): AcpDriverView['session'] => this.binding
    return {
      agent: this.agentLabel(),
      get protocol(): AcpProtocol | undefined { return connection?.protocol },
      get session(): AcpDriverView['session'] { return binding() },
      get modes(): AcpSessionModes | undefined { return current()?.modes },
      get configOptions(): readonly AcpConfigOption[] | undefined { return current()?.configOptions },
      get commands(): readonly AcpCommand[] | undefined { return current()?.commands },
      setMode: async (modeId) => { await this.requireSession().setMode(modeId) },
      setConfigOption: async (configId, value) => { await this.requireSession().setConfigOption(configId, value) },
    }
  }

  /** The session the agent holds; a command before the first turn has none to switch. */
  private requireSession(): AcpSession {
    if (this.session === undefined) throw new LlmError('the external agent has no session yet: send a message first', 'ACP_NO_SESSION')
    return this.session
  }

  /**
   * Write one segment of the external turn.
   * @returns how the external turn ended once this segment is its last, or
   *   `null` when another segment follows.
   */
  async run(position: StepPosition, _prep: void, messages: readonly UserMessage[]): Promise<StepEndReason | null> {
    // Context no person wrote, while no external turn is open, owes the agent nothing.
    if (this.exchange === undefined && !messages.some(message => message.source.kind === 'user')) return { kind: 'completed' }
    const segment = new Segment(this.host, this, position)
    this.segment = segment
    try {
      const exchange = (this.exchange ??= await this.open(position, messages))
      const result = await segment.pump(exchange)
      if (result !== null) this.exchange = undefined
      return result
    } catch (error: unknown) {
      // The external turn is over either way: it ended, broke, or was
      // cancelled. A broken connection takes its process with it.
      if (isAcpError(error) && error.kind === 'transport') this.forget()
      else this.exchange = undefined
      segment.interrupt()
      throw toFailure(error)
    } finally {
      this.segment = undefined
    }
  }

  /** End the external turn and reap its process. Idempotent. */
  async close(): Promise<void> {
    await this.connection?.dispose()
  }

  /** Forget the external process, so the next turn starts a fresh one. */
  private forget(): void {
    this.connection = undefined
    this.connecting = undefined
    this.session = undefined
    this.exchange = undefined
  }

  /** The agent's reported name once the handshake told it, and its command before that. */
  private agentLabel(): string {
    return this.connection?.agent.name ?? this.options.definition.command
  }

  private async open(position: StepPosition, messages: readonly UserMessage[]): Promise<Exchange> {
    const connection = await this.connect()
    const session = (this.session ??= await this.attach(connection, position.signal))
    const turn = session.prompt(promptBlocks(messages), { signal: position.signal })
    return { iterator: turn.updates[Symbol.asyncIterator](), end: turn.end, held: undefined }
  }

  /**
   * Open the external session: reattach to the one this session's own log
   * records while the agent still holds it, and record a fresh one otherwise.
   */
  private async attach(connection: AcpConnection, signal: AbortSignal): Promise<AcpSession> {
    const cwd = this.workingDirectory()
    const recorded = connection.agent.capabilities.resume && this.options.resume ? recordedBinding(this.host.session) : undefined
    if (recorded !== undefined && this.matches(recorded, cwd)) {
      try {
        const session = await connection.resumeSession(recorded.sessionId, { signal })
        this.binding = { id: recorded.sessionId, reached: 'resumed' }
        return session
      } catch (error: unknown) {
        // An agent that no longer holds the session gets a fresh one; any other refusal is the turn's failure.
        if (!isAcpNotFound(error)) throw error
        this.notify(`The external agent no longer holds session ${recorded.sessionId}; this turn opens a fresh one.`, 'External session not resumed')
      }
    }
    const session = await connection.newSession({ signal })
    const { command, args = [] } = this.options.definition
    const agentName = connection.agent.name
    this.host.session.append('acp/session', {
      sessionId: session.sessionId,
      reached: 'new',
      command,
      args,
      protocol: connection.protocol,
      ...agentName === undefined ? {} : { agentName },
      cwd,
    })
    this.binding = { id: session.sessionId, reached: 'new' }
    return session
  }

  /** Whether a recorded binding belongs to the agent this row launches in the directory this session uses. */
  private matches(recorded: AcpSessionEventData, cwd: string): boolean {
    const { command, args = [] } = this.options.definition
    return recorded.command === command && recorded.cwd === cwd
      && recorded.args.length === args.length && recorded.args.every((arg, index) => arg === args[index])
  }

  private connect(): Promise<AcpConnection> {
    return (this.connecting ??= this.start().then(
      (connection: AcpConnection) => {
        this.connection = connection
        // A process that exits on its own takes its connection with it; a newer one stays.
        void connection.exited.then(() => {
          if (this.connection === connection) this.forget()
        })
        return connection
      },
      (error: unknown) => {
        // A failed start must not pin this agent: the next turn tries again.
        this.connecting = undefined
        throw error
      },
    ))
  }

  private async start(): Promise<AcpConnection> {
    const credentials = await this.options.resolveEnv?.()
    return connectAcpAgent({
      definition: {
        ...this.options.definition,
        ...credentials === undefined ? {} : { env: { ...this.options.definition.env, ...credentials } },
      },
      cwd: this.workingDirectory(),
      spawn: this.options.spawn,
      permission: this.options.permission,
      questions: this.answerQuestion,
      signIn: this.signIn,
    })
  }

  /** Answer the agent's question through the consumer, and record what was asked and answered. */
  private readonly answerQuestion: AcpQuestionAnswerer = async (request): Promise<AcpQuestionAnswer> => {
    const answer = await (this.options.questions?.(request) ?? DECLINE)
    if (answer.action === 'accept') this.segment?.asked(request, answer.content)
    return answer
  }

  /** Put the address where the person signs in in front of them. */
  private link(url: string): void {
    this.notify(`Sign in to ${this.agentLabel()}: open ${url} in a browser.`, 'Sign-in link')
  }

  /**
   * Put one notice in front of the person. It is claimed by the next step,
   * where it starts no external turn.
   */
  private notify(body: string, summary: string): void {
    this.host.agent.inject(createUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: 'plugin', plugin: 'agent-acp', form: 'notice', summary: boundContextSummary(summary) },
    }))
  }

  /** Apply a title the agent gave the session; one the person chose stays. */
  title(title: string | undefined): void {
    if (title === undefined || title === '') return
    const titles = this.host.ownerCtx.get('sessionTitle')
    if (titles === undefined) return
    const current = titles.get(this.host.session)
    // Every applied title is stored as an explicit rename, so a stored title
    // is the person's own exactly when this driver did not apply it last.
    if (current !== undefined && current.source.kind === 'user' && current.title !== this.appliedTitle) return
    if (current?.title === title) return
    titles.rename(this.host.session, title)
    this.appliedTitle = title
  }

  /** Show one notice the agent published. */
  notice(update: Extract<AcpUpdate, { kind: 'notice' }>): void {
    this.notify(`${update.title}${update.message === undefined ? '' : `: ${update.message}`}`, update.title)
  }

  private workingDirectory(): string {
    const cwd = this.options.cwd ?? this.host.session.header.cwd
    if (cwd === undefined || cwd === '') {
      throw new LlmError('ACP mode needs a working directory for the external agent: give the session a workspace or configure `cwd`', 'ACP_NO_CWD')
    }
    return cwd
  }
}

/** One step's worth of the external turn: the durable events a model-loop step produces. */
class Segment {
  private readonly assembler = new BlockAssembler()
  private readonly chunkSeqs: number[] = []
  private readonly calls: SegmentCall[] = []
  private block: BlockType | undefined
  private nextIndex = 0
  private flushed = false

  constructor(
    private readonly host: AgentHost,
    private readonly driver: AcpStepDriver,
    private readonly position: StepPosition,
  ) {}

  /**
   * Read updates until this segment closes or the external turn ends. Text
   * that arrives after a tool call opens the next segment, but only once every
   * call of this one reported: a result must land in the step of its call.
   */
  async pump(exchange: Exchange): Promise<StepEndReason | null> {
    // Only speech is held, and a fresh segment has no calls, so the replay never closes.
    if (exchange.held !== undefined) {
      const held = exchange.held
      exchange.held = undefined
      this.absorb(held, exchange)
    }
    while (true) {
      const next = await exchange.iterator.next()
      if (next.done !== true) {
        if (this.absorb(next.value, exchange) === 'closed') return this.close()
        continue
      }
      let end: AcpTurnEnd
      try {
        end = await exchange.end
      } catch (error: unknown) {
        // A broken turn keeps its streamed prefix as an interrupted message.
        this.flush(true)
        throw error
      }
      // A cancelled turn does the same; a refused or failed one streamed in full.
      this.flush(this.position.signal.aborted)
      switch (end.stopReason) {
        case 'end_turn':
          return { kind: 'completed' }
        case 'max_tokens':
          return { kind: 'max-tokens' }
        case 'cancelled':
          throw new Error('the external agent cancelled the turn')
        default:
          // Only a v2 agent reports an idle state that carries the agent's own explanation.
          /* v8 ignore next -- the v1 test agent has no way to deliver an error message */
          throw new Error(`the external agent stopped with "${end.stopReason}"${end.error === undefined ? '' : `: ${end.error}`}`)
      }
    }
  }

  /** Finalize this segment; the next one is another step of the same external turn. */
  private close(): null {
    this.flush(false)
    return null
  }

  /** Finalize what streamed before a failure; a cancelled step keeps its partial text. */
  interrupt(): void {
    this.flush(true)
  }

  /** Record a question the agent asked and what was answered, as one completed call. */
  asked(request: AcpQuestionRequest, content: Readonly<Record<string, AcpQuestionValue>>): void {
    const labels = Object.fromEntries(request.fields.map(field => [field.name, field.label]))
    this.toolCall({
      toolCallId: `question-${this.calls.length + 1}`,
      name: QUESTION_TOOL,
      title: request.message,
      status: 'completed',
      rawInput: labels,
      content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(content) } }],
    })
  }

  /** Apply one update; `closed` means the following updates belong to a new step. */
  private absorb(update: AcpUpdate, exchange: Exchange): 'open' | 'closed' {
    switch (update.kind) {
      case 'message-chunk':
      case 'thought-chunk': {
        const value = text(update.content)
        if (value === undefined) return 'open'
        if (this.calls.length > 0) {
          exchange.held = update
          return this.settled() ? 'closed' : 'open'
        }
        this.chunk({
          type: update.kind === 'message-chunk' ? 'text-delta' : 'reasoning-delta',
          index: this.openBlock(update.kind === 'message-chunk' ? 'text' : 'reasoning'),
          text: value,
        })
        return 'open'
      }
      case 'tool-call': {
        const completed = this.toolCall(update.patch)
        // A result arriving behind held speech closes the segment once nothing is pending.
        if (completed && exchange.held !== undefined && this.settled()) return 'closed'
        return 'open'
      }
      case 'plan':
        // A plan report replaces the standing todo list whole.
        this.host.session.append('todo/write', { todos: planTodos(update.entries) })
        return 'open'
      case 'plan-removed':
        this.host.session.append('todo/write', { todos: [] })
        return 'open'
      case 'session-info':
        this.driver.title(update.title)
        return 'open'
      case 'notice':
        this.driver.notice(update)
        return 'open'
      default:
        return 'open'
    }
  }

  /** Whether every call of this segment reported. */
  private settled(): boolean {
    return this.calls.every(call => call.completion !== undefined)
  }

  private openBlock(block: BlockType): number {
    if (this.block !== block) {
      this.block = block
      this.nextIndex += 1
      this.chunk({ type: 'block-start', index: this.nextIndex - 1, blockType: block })
    }
    return this.nextIndex - 1
  }

  private chunk(chunk: StreamChunk): void {
    const { turn, step } = this.position
    this.chunkSeqs.push(this.host.session.append('assistant/chunk', { turn, step, chunk }).seq)
    this.assembler.push(chunk)
  }

  /** Record a started or updated call; `true` when this update reported its completion. */
  private toolCall(patch: AcpToolCallPatch): boolean {
    let call = this.calls.find(candidate => candidate.callId === patch.toolCallId)
    if (call === undefined) {
      call = {
        callId: CallId(patch.toolCallId),
        name: patch.name ?? patch.kind ?? 'tool',
        arguments: patch.rawInput === undefined ? patch.title ?? '' : JSON.stringify(patch.rawInput),
        title: patch.title ?? undefined,
        completion: undefined,
      }
      this.calls.push(call)
      const index = this.nextIndex++
      const block: ContentBlock = { type: 'tool-call', id: call.callId, name: call.name, arguments: call.arguments }
      this.chunk({ type: 'block-start', index, blockType: 'tool-call' })
      this.chunk({ type: 'tool-call-delta', index, id: call.callId, name: call.name, argumentsDelta: call.arguments })
      this.chunk({ type: 'block-end', index, block })
      this.block = undefined
    }
    if (patch.title !== undefined && patch.title !== null) call.title = patch.title
    if (patch.status !== 'completed' && patch.status !== 'failed') return false
    call.completion = patch
    return true
  }

  /** Write the segment's assistant message, then the calls it made and their results. */
  private flush(interrupted: boolean): void {
    if (this.flushed) return
    this.flushed = true
    const { turn, step } = this.position
    // A message with no block writes nothing; its calls still log below.
    const content = this.chunkSeqs.length === 0 ? [] : interrupted ? this.assembler.interruptedBlocks() : this.assembler.blocks()
    if (content.length > 0) {
      this.host.session.append('assistant/message', {
        turn,
        step,
        message: createAssistantMessage({ content, source: { provider: 'acp', model: this.driverLabel() } }),
        ...interrupted ? { interrupted: true } : {},
      }, { surfaceOp: 'append', sourceEventSeqs: [...this.chunkSeqs] })
    }
    for (const call of this.calls) {
      this.host.session.append('tool/call', { turn, step, callId: call.callId, name: call.name, arguments: call.arguments })
    }
    for (const call of this.calls) {
      const completion = call.completion
      const isError = completion === undefined || completion.status === 'failed'
      this.host.session.append('tool/result', {
        turn,
        step,
        message: createToolResultMessage({
          callId: call.callId,
          content: completion === undefined
            ? [{ type: 'text', text: 'The external agent ended the turn without reporting a result for this tool call.' }]
            : resultContent(call),
          isError,
        }),
        ...isError ? { error: { name: 'AcpToolError', code: completion === undefined ? 'incomplete' : 'failed' } } : {},
      }, { surfaceOp: 'append' })
    }
  }

  /** The label the agent's messages are attributed to. */
  private driverLabel(): string {
    return this.driver.view().agent
  }
}
