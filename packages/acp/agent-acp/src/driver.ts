/**
 * The ACP step driver: each step is one segment of an external agent's turn,
 * written into the session log in the shape the model loop produces. A
 * segment ends when the external agent speaks again after its tool calls all
 * reported, or when its turn ends; the machine then opens the next step.
 * @module @deepseek-ai/dsh-agent-acp/driver
 */

import type { AgentHost, StepDriver, StepEndReason, StepPosition } from '@deepseek-ai/dsh-agent'
import { allowAnswer, connectAcpAgent, isAcpError } from '@deepseek-ai/dsh-acp-client'
import type {
  AcpAgentDefinition,
  AcpConnection,
  AcpContentBlock,
  AcpPermissionAnswer,
  AcpPermissionAnswerer,
  AcpPermissionRequest,
  AcpPromptBlock,
  AcpSession,
  AcpToolCallPatch,
  AcpTurnEnd,
  AcpUpdate,
} from '@deepseek-ai/dsh-acp-client'
import {
  BlockAssembler,
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  errorChain,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SubprocessSpawnSpec, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
// Type-only: resolves the `approval` service this driver reads through `ctx.get`.
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: resolves the `approval` service this driver reads through `ctx.get`.
import type {} from '@deepseek-ai/dsh-user-approval'

/** How the driver answers the external agent's permission requests. */
export type AcpPermissionMode = 'ask' | 'allow' | 'reject'

/** What the plugin resolved for one agent's driver. */
export interface AcpDriverOptions {
  readonly definition: AcpAgentDefinition
  /** Working directory of the external process; the session's own when omitted. */
  readonly cwd: string | undefined
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

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
const DECLINE: AcpPermissionAnswer = { outcome: { outcome: 'cancelled' } }

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
    if (mode === 'reject') return DECLINE
    if (mode === 'allow') return allowAnswer(request)
    const approval = host.ownerCtx.get('approval')
    if (approval === undefined) return DECLINE
    const callId = request.toolCallId === undefined ? undefined : CallId(request.toolCallId)
    const outcome = await approval.request({
      agent: host.agent,
      toolName: request.title === undefined || request.title === '' ? 'an external tool' : request.title,
      ...callId === undefined ? {} : { callId },
      ...request.reason === undefined ? {} : { reason: request.reason },
      signal: request.signal,
    })
    return outcome === 'allowed-once' ? allowAnswer(request) : DECLINE
  }
}

/**
 * Drives an agent through an external ACP agent. The connection opens at the
 * first step and lives until the agent's scope unwinds, which reaps the
 * external process.
 */
export class AcpStepDriver implements StepDriver<void> {
  private connection: AcpConnection | undefined
  private connecting: Promise<AcpConnection> | undefined
  private session: AcpSession | undefined
  private exchange: Exchange | undefined

  constructor(
    private readonly host: AgentHost,
    private readonly options: AcpDriverOptions,
    private readonly permission: AcpPermissionAnswerer,
  ) {
    // The external process lives exactly as long as this agent.
    host.ctx.effect(() => () => this.close(), 'agent-acp.connection()')
  }

  /** The external agent needs no per-step preparation. */
  prepare(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Write one segment of the external turn.
   * @returns how the external turn ended once this segment is its last, or
   *   `null` when another segment follows.
   */
  async run(position: StepPosition, _prep: void, messages: readonly UserMessage[]): Promise<StepEndReason | null> {
    const segment = new Segment(this.host, position, () => this.agentLabel())
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
    const session = (this.session ??= await connection.newSession())
    const turn = session.prompt(promptBlocks(messages), { signal: position.signal })
    return { iterator: turn.updates[Symbol.asyncIterator](), end: turn.end, held: undefined }
  }

  private connect(): Promise<AcpConnection> {
    return (this.connecting ??= connectAcpAgent({
      definition: this.options.definition,
      cwd: this.workingDirectory(),
      spawn: this.options.spawn,
      permission: this.permission,
    }).then(
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
    private readonly position: StepPosition,
    private readonly source: () => string,
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
        message: createAssistantMessage({ content, source: { provider: 'acp', model: this.source() } }),
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
}
