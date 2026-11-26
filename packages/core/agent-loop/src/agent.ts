/**
 * The model-loop step driver: one step is one model request plus the tools it
 * calls. Every request is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { AgentHost, StepDriver, StepDriverDefinition, StepEndReason, StepPosition } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, LlmWireAttempt, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  createAssistantMessage,
  deepFreeze,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { EpochHeader, RequestContext } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { executeToolCalls } from './tool-calls.ts'

/** Remove adapter-derived values before plugins propose the next request config. */
/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/** The default step driver: the model loop. */
export const modelLoopDriver: StepDriverDefinition = host => new ModelLoopDriver(host)

/**
 * Drives one step of an agent through a model request and the tool calls it
 * returns. The machine owns the turn, the claim, and the step boundaries.
 */
class ModelLoopDriver implements StepDriver<PromptAssembly> {
  private requestHeaderLogged = false

  constructor(private readonly host: AgentHost) {}

  /** Each step reads the prompt sections and tool schemas that plugins registered. */
  prepare(position: StepPosition): Promise<PromptAssembly> {
    return this.host.ownerCtx.systemPrompt.assemble(assembleContextFor(this.host.agent, position.signal))
  }

  run(position: StepPosition, assembly: PromptAssembly): Promise<StepEndReason | null> {
    // The entered messages reach the request through the session log, not this argument.
    return this.step(position, assembly)
  }

  private async step(position: StepPosition, assembly: PromptAssembly): Promise<StepEndReason | null> {
    const { turn, step, signal } = position
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    while (true) {
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, this.host.session.deriveMessages(), signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      const appendInterrupted = (): void => {
        const content = assembler.interruptedBlocks()
        if (content.length === 0) return
        this.host.session.append('assistant/message', {
          turn,
          step,
          message: createAssistantMessage({
            content,
            source: { provider: request.provider, model: request.model },
          }),
          interrupted: true,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
      }
      try {
        const stream = preparedCall?.stream(request) ?? this.host.ownerCtx.llm.stream(request)
        signal.throwIfAborted()
        for await (const chunk of stream) {
          signal.throwIfAborted()
          chunkSeqs.push(this.host.session.append('assistant/chunk', { turn, step, chunk }).seq)
          assembler.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (signal.aborted) appendInterrupted()
        throw error
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const action = await this.host.dispatch.waterfall(
          'agent/request-error', {
            turn,
            step,
            provider: request.provider,
            model: request.model,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
            signal,
          },
          () => Promise.resolve<RequestErrorAction>(undefined),
        )
        signal.throwIfAborted()
        if (action?.kind !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        continue
      }

      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
      })
      this.host.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(
        this.host.ownerCtx, turn, step, toolCalls, signal,
        context => this.host.inbox.splice('next-step', this.host.inbox.nextStep.length, 0, [context]),
      )
      return concluded ? { kind: 'completed' } : null
    }
  }

  /**
   * Compose one frozen request and bind it to the adapter registration that
   * resolved its exact-model defaults.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    signal: AbortSignal,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    const { session } = this.host
    const boundaryEventCount = session.seq

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.host.options.provider ?? '', model: this.host.options.model ?? '' }
    const reasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const maxTokens = this.host.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.host.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.host.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.host.ownerCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()

    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.host.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.host.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.host.session.append('request/header', { header, reason: 'change' })
    }

    const contextWindow = preparedCall?.context?.contextWindow
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    // A request listener may complete an automatic compaction or append
    // durable model-facing context (runtime-context recovery) before returning
    // its config. Rebuild the derived history whenever the log grew during the
    // waterfall, so the request carries the committed surface — both replace
    // and append operations — instead of the boundary snapshot.
    const requestMessages = session.seq === boundaryEventCount
      ? boundaryMessages
      : session.deriveMessages()
    const requestHeaderSeq = session.events.findLast(event => event.type === 'request/header')?.seq
    /* v8 ignore next -- the request/header event is committed above before wire dispatch. */
    if (requestHeaderSeq === undefined) throw new Error('agent request header was not logged before wire dispatch')
    const requestContextSeq = session.events.findLast(event => event.type === 'request/context')?.seq
    const historyCutSeq = session.eventAt(session.seq - 1)?.seq
    const wireExchangeId = crypto.randomUUID()
    const onWireAttempt = (attempt: LlmWireAttempt): void => {
      session.append('llm/wire-attempt', {
        ...attempt,
        turn,
        step,
        /* v8 ignore next -- every request has a committed session event before wire dispatch. */
        ...historyCutSeq === undefined ? {} : { historyCutSeq },
        requestHeaderSeq,
        /* v8 ignore next -- every request has a request/context event before wire dispatch. */
        ...requestContextSeq === undefined ? {} : { requestContextSeq },
      })
    }
    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: requestMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.host.session.id,
      signal,
      wireExchangeId,
      onWireAttempt,
    }))
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
}
