/**
 * The ACP step driver: each step is one segment of an external agent's turn,
 * written into the session log in the shape the model loop produces. A
 * segment ends when the external agent speaks again after its tool calls all
 * reported, or when its turn ends; the machine then opens the next step.
 * @module @deepseek-ai/dsh-agent-acp/driver
 */

import { basename } from 'node:path'
import type { AgentContextEventData, AgentHost, StepDriver, StepEndReason, StepPosition } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
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
  AcpUsage,
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
import { appliedTitle, recordedBinding, recordedContext, type AcpSessionEventData } from './session.ts'

/** How the driver answers the external agent's permission requests. */
export type AcpPermissionMode = 'ask' | 'allow' | 'reject'

/** How the plugin launches one agent: a definition whose arguments are always set. */
export type LaunchDefinition = AcpAgentDefinition & { readonly args: readonly string[] }

/** One external agent the row can launch. */
export interface AcpLaunch {
  /** Name the person picks the agent by. */
  readonly name: string
  readonly definition: LaunchDefinition
  /** Resolves the credential-backed environment of one start; a resolved value is never kept. */
  readonly resolveEnv?: () => Promise<Record<string, string>>
}

/** What the plugin resolved for one row's driver. */
export interface AcpDriverOptions {
  /** Every agent the row can drive, in configuration order. */
  readonly agents: readonly AcpLaunch[]
  /** The agent a session runs until its own log or the person names another. */
  readonly defaultAgent: string
  /** Working directory of the external process; the session's own when omitted. */
  readonly cwd: string | undefined
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly permission: AcpPermissionAnswerer
  /** Asks the person what the agent wants to know; omitted declines every question. */
  readonly questions?: AcpQuestionAnswerer
  /** Asks the person to complete a terminal sign-in; omitted refuses one. */
  readonly terminalSignIn?: AcpSignInHooks['terminal']
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
  /** The agents a person can pick by name; empty for a row that drives one. */
  readonly agents: readonly string[]
  /** The agent the next message runs on; empty for a row that drives one. */
  readonly current: string
  /** The agent's latest context accounting, once it reported one. */
  readonly context: AgentContextEventData | undefined
  /**
   * Choose the agent the next messages run on. A running external turn refuses
   * the switch. A different agent starts its own process, and its next message
   * reattaches to the external session it opened earlier in this session when
   * it still holds one.
   * @param name - one of `agents`.
   * @returns whether the agent in effect changed.
   */
  select(name: string): Promise<boolean>
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

/** An image the person attached or the agent sent, as the protocol carries it. */
interface Image {
  readonly data: string
  readonly mimeType: string
  /** Display name without local path information. */
  readonly name?: string
}

/** Read a content block as an image; anything else, or an image missing a field, reads as none. */
function imageOf(content: AcpContentBlock): Image | undefined {
  if (content.type !== 'image' || typeof content.data !== 'string' || typeof content.mimeType !== 'string') return undefined
  const name = typeof content.uri === 'string' ? basename(content.uri).trim() : ''
  return { data: content.data, mimeType: content.mimeType, ...name === '' ? {} : { name } }
}

/** What building one prompt found. */
interface BuiltPrompt {
  readonly blocks: AcpPromptBlock[]
  /** Each person's image that stays behind, with the reason the person reads. */
  readonly withheld: string[]
}

/** One block of the person's input, in its order. */
type Input =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef; readonly label: string }

/** What reading one stored image yielded. */
type Read = { readonly data: Uint8Array } | { readonly failure: string }

/** Read one stored image; a read that fails yields the failure for the person rather than the turn. */
async function readStored(store: AttachmentStore, attachment: ImageAttachmentRef, signal: AbortSignal): Promise<Read> {
  try {
    const { data } = await store.readImage(attachment, signal)
    return { data }
  } catch (error: unknown) {
    // A stored image that cannot be read back stays behind: the turn goes on, and the person reads why.
    return { failure: errorChain(error) }
  }
}

/**
 * Prompt blocks for the step's input: the text and the images the person
 * wrote, in their order. Context that harness plugins inject is left out,
 * because the external agent owns its own context. An image reaches the agent
 * only when its handshake admits image prompts and the attachment store reads
 * it back; otherwise it stays behind and is named for the person. A prompt
 * without a single block sends a placeholder.
 * @param messages - the messages the machine entered for this step.
 * @param store - the attachment store holding the person's images.
 * @param acceptsImages - whether the agent's handshake admitted image prompts.
 * @param signal - ends an image read when the step is cancelled.
 * @returns the blocks the external agent receives and the images withheld.
 */
async function promptBlocks(
  messages: readonly UserMessage[],
  store: AttachmentStore | undefined,
  acceptsImages: boolean,
  signal: AbortSignal,
): Promise<BuiltPrompt> {
  const input: Input[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text.trim() !== '') input.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        input.push({ type: 'image', attachment: block.attachment, label: block.attachment.name ?? 'an image' })
      }
    }
  }
  // Every image is read before the prompt is assembled, so assembling it decides nothing asynchronously.
  const images = input.filter((part): part is Extract<Input, { type: 'image' }> => part.type === 'image')
  const reads = store === undefined ? [] : await Promise.all(images.map(image => readStored(store, image.attachment, signal)))
  const blocks: AcpPromptBlock[] = []
  const withheld: string[] = []
  for (const part of input) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (!acceptsImages) {
      withheld.push(`${part.label}: this agent does not accept images`)
      continue
    }
    const read = reads[images.indexOf(part)]
    if (read === undefined) {
      withheld.push(`${part.label}: the harness mounted no attachment store`)
    } else if ('data' in read) {
      blocks.push({ type: 'image', data: Buffer.from(read.data).toString('base64'), mimeType: part.attachment.mediaType })
    } else {
      withheld.push(`${part.label}: ${read.failure}`)
    }
  }
  return { blocks: blocks.length === 0 ? [{ type: 'text', text: '(no text content)' }] : blocks, withheld }
}

/** A token count fit for the log: whole and within its range, or absent. */
function count(value: number | undefined, minimum: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= minimum ? Math.floor(value) : undefined
}

/**
 * The record one usage report writes. Only counts that are whole numbers in
 * range reach the log; a report without a usable `used` writes nothing.
 * @param usage - the agent's report.
 * @returns the `agent/context` payload, or `undefined` for a report that says nothing recordable.
 */
function contextData(usage: AcpUsage): AgentContextEventData | undefined {
  const used = count(usage.used, 0)
  if (used === undefined) return undefined
  const size = count(usage.size, 1)
  const cost = usage.cost
  return {
    used,
    ...size === undefined ? {} : { size },
    ...cost === undefined || count(cost.amount, 0) === undefined ? {} : { cost: { amount: cost.amount, currency: cost.currency } },
  }
}

/** Whether a recorded binding was made by the launch `definition` describes. */
function launched(definition: LaunchDefinition, recorded: AcpSessionEventData): boolean {
  const { command, args } = definition
  return recorded.command === command
    && recorded.args.length === args.length && args.every((arg, index) => arg === recorded.args[index])
}

/** Whether two context records say the same thing. */
function sameContext(left: AgentContextEventData, right: AgentContextEventData): boolean {
  return left.used === right.used && left.size === right.size
    && (left.cost === undefined || right.cost === undefined
      ? left.cost === right.cost
      : left.cost.amount === right.cost.amount && left.cost.currency === right.cost.currency)
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
  /** Whether a step is opening or running an external turn. */
  private busy = false
  /** The segment the running step writes, where a question the agent asks is recorded. */
  private segment: Segment | undefined
  /** The external session in effect and how it was reached. */
  private binding: AcpDriverView['session']
  /** The agent in effect for this session, once its log or the person settled it. */
  private choice: string | undefined
  /** The document plans already shown, by plan id: a document reported unchanged is not shown twice. */
  private readonly documents = new Map<string, string>()
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
    // A row that drives one agent has nothing to choose, and shows no name.
    const several = this.options.agents.length > 1
    return {
      agent: this.agentLabel(),
      get protocol(): AcpProtocol | undefined { return connection?.protocol },
      get session(): AcpDriverView['session'] { return binding() },
      get modes(): AcpSessionModes | undefined { return current()?.modes },
      get configOptions(): readonly AcpConfigOption[] | undefined { return current()?.configOptions },
      get commands(): readonly AcpCommand[] | undefined { return current()?.commands },
      agents: several ? this.options.agents.map(agent => agent.name) : [],
      current: several ? this.selected() : '',
      context: recordedContext(this.host.session),
      select: async name => this.select(name),
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
   * The agent the next message runs on: the one the person chose, else the
   * one this session last talked to while it still drives it, else the row's
   * default. The log is read once; a later choice is the person's.
   */
  private selected(): string {
    if (this.choice !== undefined) return this.choice
    const last = recordedBinding(this.host.session)
    const named = this.options.agents.find(agent => last !== undefined && launched(agent.definition, last))
    return (this.choice = named?.name ?? this.options.defaultAgent)
  }

  /** The launch of the agent in effect. */
  private launch(): AcpLaunch {
    const selected = this.selected()
    const launch = this.options.agents.find(agent => agent.name === selected)
    // The selection is drawn from the configured names, so it always names one.
    /* v8 ignore next -- no caller can select a name the row does not drive */
    if (launch === undefined) throw new LlmError(`no external agent named "${selected}"`, 'ACP_NO_AGENT')
    return launch
  }

  /**
   * Choose the agent the next messages run on. A turn that is opening or
   * running refuses the switch; a different agent takes a process of its own,
   * so the running one is reaped.
   * @param name - one of the row's agents.
   * @returns whether the agent in effect changed.
   */
  private async select(name: string): Promise<boolean> {
    if (!this.options.agents.some(agent => agent.name === name)) {
      throw new LlmError(`no agent named "${name}" (${this.options.agents.map(agent => agent.name).join(', ')})`, 'ACP_NO_AGENT')
    }
    if (this.busy) {
      throw new LlmError('the external agent is running a turn: wait for it to end before choosing another agent', 'ACP_TURN_ACTIVE')
    }
    const changed = this.selected() !== name
    this.choice = name
    if (!changed) return false
    await this.close()
    this.forget()
    // No external session is in effect until the chosen agent opens or resumes one.
    this.binding = undefined
    return true
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
    this.busy = true
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
      await segment.interrupt()
      throw toFailure(error)
    } finally {
      this.busy = false
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
    return this.connection?.agent.name ?? this.launch().definition.command
  }

  private async open(position: StepPosition, messages: readonly UserMessage[]): Promise<Exchange> {
    const connection = await this.connect()
    const session = (this.session ??= await this.attach(connection, position.signal))
    // The handshake decides what the agent takes, so the prompt is built once it answered.
    const prompt = await promptBlocks(
      messages,
      this.attachments(),
      connection.agent.capabilities.prompt.image,
      position.signal,
    )
    for (const withheld of prompt.withheld) this.notify(`Not forwarded to the external agent: ${withheld}.`, 'Attachment not forwarded')
    const turn = session.prompt(prompt.blocks, { signal: position.signal })
    return { iterator: turn.updates[Symbol.asyncIterator](), end: turn.end, held: undefined }
  }

  /**
   * Open the external session: reattach to the one this session's own log
   * records for the agent in effect while the agent still holds it, and record
   * a fresh one otherwise.
   */
  private async attach(connection: AcpConnection, signal: AbortSignal): Promise<AcpSession> {
    const cwd = this.workingDirectory()
    const { definition } = this.launch()
    const recorded = connection.agent.capabilities.resume && this.options.resume
      ? recordedBinding(this.host.session, data => launched(definition, data))
      : undefined
    if (recorded !== undefined) {
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
    const { command, args } = definition
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
    const { definition, resolveEnv } = this.launch()
    const credentials = await resolveEnv?.()
    return connectAcpAgent({
      definition: {
        ...definition,
        ...credentials === undefined ? {} : { env: { ...definition.env, ...credentials } },
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
    // Every applied title is stored as an explicit rename. The one recorded last
    // is the agent's, so a standing title is the person's own exactly when it is
    // neither that one nor absent.
    if (current !== undefined && current.source.kind === 'user' && current.title !== appliedTitle(this.host.session)) return
    if (current?.title === title) return
    const accepted = titles.rename(this.host.session, title)
    this.host.session.append('acp/title', { title: accepted.title })
  }

  /** Record the agent's context accounting; a report that says what the last record says writes nothing. */
  context(usage: AcpUsage): void {
    const data = contextData(usage)
    const last = recordedContext(this.host.session)
    if (data === undefined || (last !== undefined && sameContext(last, data))) return
    this.host.session.append('agent/context', data)
  }

  /** Show a plan the agent keeps as a document; one it reports unchanged is not shown twice. */
  planDocumentShown(update: Extract<AcpUpdate, { kind: 'plan-document' }>): void {
    if (this.documents.get(update.planId) === update.content) return
    this.documents.set(update.planId, update.content)
    const where = update.path === undefined ? '' : ` (${update.path})`
    this.notify(`The agent's plan${where}:\n\n${update.content}`, 'Plan document updated')
  }

  /** Whether a plan id names a document this driver showed. */
  hasDocument(planId: string): boolean {
    return this.documents.has(planId)
  }

  /** Forget a document plan the agent removed; the todo list was never its. */
  forgetDocument(planId: string): void {
    this.documents.delete(planId)
  }

  /** Show one notice the agent published. */
  notice(update: Extract<AcpUpdate, { kind: 'notice' }>): void {
    this.notify(`${update.title}${update.message === undefined ? '' : `: ${update.message}`}`, update.title)
  }

  /** The store holding the person's images and the agent's; absent in a composition that mounts none. */
  attachments(): AttachmentStore | undefined {
    return this.host.ownerCtx.get('attachments')
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
  /** The images the agent streamed into this segment's message, in arrival order. */
  private readonly images: Image[] = []
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
        await this.flush(true)
        throw error
      }
      // A cancelled turn does the same; a refused or failed one streamed in full.
      await this.flush(this.position.signal.aborted)
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
  private async close(): Promise<null> {
    await this.flush(false)
    return null
  }

  /** Finalize what streamed before a failure; a cancelled step keeps its partial text. */
  async interrupt(): Promise<void> {
    await this.flush(true)
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
        // An image is a whole block; it is stored when the segment is written.
        const image = update.kind === 'message-chunk' ? imageOf(update.content) : undefined
        if (image !== undefined) {
          this.images.push(image)
          return 'open'
        }
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
      case 'plan-document':
        this.driver.planDocumentShown(update)
        return 'open'
      case 'plan-removed':
        // A document never fed the todo list, so its removal leaves the list alone.
        if (this.driver.hasDocument(update.planId)) this.driver.forgetDocument(update.planId)
        else this.host.session.append('todo/write', { todos: [] })
        return 'open'
      case 'usage':
        this.driver.context(update.usage)
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

  /**
   * Store one image the agent sent, as the block the log carries. An image the
   * harness cannot store — no attachment store, a type the store does not
   * keep, or bytes it cannot decode — becomes a text note that says so.
   */
  private async imageBlock(image: Image): Promise<Extract<ContentBlock, { type: 'image' | 'text' }>> {
    const note = (reason: string): { type: 'text'; text: string } => ({
      type: 'text',
      text: `[image${image.name === undefined ? '' : ` ${image.name}`} (${image.mimeType}) not shown: ${reason}]`,
    })
    const store = this.driver.attachments()
    if (store === undefined) return note('the harness mounted no attachment store')
    if (!store.imageLimits.mediaTypes.some(mediaType => mediaType === image.mimeType)) {
      return note(`the harness does not store ${image.mimeType}`)
    }
    try {
      const attachment = await store.saveImage({
        data: new Uint8Array(Buffer.from(image.data, 'base64')),
        mediaType: image.mimeType as ImageMediaType,
        ...image.name === undefined ? {} : { name: image.name },
      })
      return { type: 'image', attachment }
    } catch (error: unknown) {
      // The bytes failed the store's admission; the person reads why instead of seeing nothing.
      return note(errorChain(error))
    }
  }

  /** The content of a tool call's result: its text and its images, in the order the agent reported them. */
  private async resultContent(call: SegmentCall): Promise<ContentBlock[]> {
    const blocks: AcpContentBlock[] = []
    for (const item of call.completion?.content ?? []) {
      // Only a standard content item carries a block; a diff or a terminal reference carries none.
      if (item.type === 'content' && typeof item.content === 'object' && item.content !== null) blocks.push(item.content as AcpContentBlock)
    }
    // Every image is stored before the content is assembled, so assembling it decides nothing asynchronously.
    const stored = await Promise.all(blocks.map(async (block) => {
      const image = imageOf(block)
      return image === undefined ? undefined : this.imageBlock(image)
    }))
    const content: ContentBlock[] = []
    for (const [index, block] of blocks.entries()) {
      const value = text(block)
      const image = stored[index]
      if (value !== undefined) content.push({ type: 'text', text: value })
      else if (image !== undefined) content.push(image)
    }
    return content.length === 0 ? [{ type: 'text', text: call.title ?? '' }] : content
  }

  /**
   * Write the segment's assistant message, then the calls it made and their
   * results. An image is stored as a whole block once its bytes are complete,
   * so a message interrupted before its turn ended keeps its text and none of
   * its images; a result a tool call reported is complete either way.
   */
  private async flush(interrupted: boolean): Promise<void> {
    if (this.flushed) return
    this.flushed = true
    const { turn, step } = this.position
    if (!interrupted) {
      const stored = await Promise.all(this.images.map(image => this.imageBlock(image)))
      for (const block of stored) {
        if (block.type === 'image') {
          const index = this.nextIndex++
          this.chunk({ type: 'block-start', index, blockType: 'image' })
          this.chunk({ type: 'block-end', index, block })
        } else {
          this.chunk({ type: 'text-delta', index: this.openBlock('text'), text: block.text })
        }
      }
    }
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
            : await this.resultContent(call),
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
