/**
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider availability controls tool registration and context-sensitive schema
 * wording. Every invocation uses the durable continuable Session path; `sync`
 * only waits for the initial turn while `async` returns after admission.
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import type {
  ChildProfileSpec,
  ChildProfileGrant,
  ResolvedChildProfile,
  SubagentProvider,
  SubagentResult,
  SubagentInvocation,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Prompt order after bounded delegation policy and before child reporting. */
const SUBAGENT_SECTION_ORDER = 116.5

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Allow asynchronous invocations (default true). Disabled instances reject
   * `mode: async` calls.
   */
  enableRunInBackground?: boolean
  /**
   * Legacy lifecycle setting retained for old deployment files.
   * @deprecated Explicit `one-shot` keeps omitted mode synchronous and routes
   * that synchronous call through the one-shot provider path. Ordinary calls
   * use continuable Sessions; explicit asynchronous calls are always continuable.
   */
  backgroundMode?: 'one-shot' | 'continuable'
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Per-child persona that shadows the dynamic `deployment:persona` context. Requires the
   * provider's `persona` capability; omission preserves the deployment persona.
   */
  persona?: string
  /**
   * Tool filter applied to every child. Filtered tools disappear from its
   * prompt and reject execution. Requires the provider's `toolFilter`
   * capability; unknown names fail startup.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /**
   * Maximum child depth: a non-negative safe integer (default `3`; `0` forbids
   * delegation entirely), or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment.
   */
  maxDepth?: number | 'provider-managed'
  /** Expose parent-private `child_profile_define`. */
  enableChildProfileDefine?: boolean
  /** Expose parent-private `child_profile_list`. */
  enableChildProfileList?: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as { provider: string; model: string; maxTokens: number }),
  persona: z.string(),
  // Preserve omission; Schemastery's `{ allow: [] }` default would deny every tool.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
  enableChildProfileDefine: z.boolean().default(false),
  enableChildProfileList: z.boolean().default(false),
})

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append provider-authored failure detail and the child's preserved partial
 * answer to a stop-reason error while keeping it separate from assistant text.
 * @param error - the stop-reason headline.
 * @param result - the child's terminal result.
 * @returns the headline, diagnostic, and partial text that are present.
 */
function withDiagnosticAndPartialText(error: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined
    ? ''
    : `\nDiagnostic: ${result.diagnostic}`
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const partial = text.length === 0
    ? ''
    : `\nPartial output before the run ended:\n${text}`
  return `${error}${diagnostic}${partial}`
}

type ForegroundToolResult = {
  readonly mode: 'sync'
  readonly invocationId: string
  readonly sessionId: string
  readonly output: JsonValue[]
  /** Explicit marker for the deprecated one-shot escape hatch. */
  readonly legacy?: true
}

type AsyncToolResult = {
  readonly mode: 'async'
  readonly invocationId: string
  readonly sessionId: string
}

function continuationInstruction(sessionId: string): string {
  return `Use session_message with session_id "${sessionId}" for a later turn and session_inspect with the same session_id to read its state or transcript.`
}

/** Render the legacy one-shot route without advertising continuation. */
function legacyCompletionInstruction(sessionId: string): string {
  return `Use session_inspect with session_id "${sessionId}" to read its state or transcript. This legacy one-shot Session does not accept later turns.`
}

function renderInvocationResult(value: ForegroundToolResult | AsyncToolResult): string {
  if (value.mode === 'async') {
    return `Started async subagent session ${value.sessionId} with invocation ${value.invocationId}. ${continuationInstruction(value.sessionId)}`
  }
  const output = outputValueText(value.output)
  const instruction = value.legacy === true
    ? legacyCompletionInstruction(value.sessionId)
    : continuationInstruction(value.sessionId)
  return `Subagent session ${value.sessionId} completed invocation ${value.invocationId}. ${instruction}${output.length === 0 ? '' : `\n\nFinal output:\n${output}`}`
}

/** Collect and release a legacy one-shot run. */
async function settleLegacyRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withDiagnosticAndPartialText(error, result))
      return {
        mode: 'sync',
        invocationId: run.id,
        sessionId: run.id,
        output: result.output as unknown as JsonValue[],
        legacy: true,
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Collect and release one foreground run without letting disposal replace an
 * independent result failure.
 */
async function settleForegroundInvocation(
  invocation: Extract<SubagentInvocation, { readonly mode: 'sync' }>,
): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    invocation.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // The registry converts this throw to isError; partial output is not
        // success, but the preserved partial answer still reaches the parent.
        throw new Error(withDiagnosticAndPartialText(error, result))
      }
      return {
        mode: 'sync',
        invocationId: invocation.invocationId,
        sessionId: invocation.sessionId,
        // Content blocks already cross durable JSON boundaries elsewhere;
        // the registry performs the authoritative lossless snapshot here.
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  if (execution.status === 'rejected') {
    throw execution.reason
  }
  return execution.value
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

interface DelegationRunRequest {
  readonly mode?: 'sync' | 'async'
}

function profileJson(profile: ResolvedChildProfile): JsonValue {
  return profile as unknown as JsonValue
}

function profileParameters() {
  return {
    child_profile_id: { type: 'string' as const, required: true as const, description: 'Id in this parent Agent\'s private Child Profile namespace. Defining an existing id replaces its complete specification with a new revision.' },
    harness_id: { type: 'string' as const, description: 'Granted child harness id. Omit to use the configured delegation provider shown by child_profile_list.' },
    model_route_id: { type: 'string' as const, description: 'Granted model route id. Omit to use the parent current route shown by child_profile_list.' },
    tools: { type: 'array' as const, items: { type: 'string' as const }, description: 'Granted child Tool ids. Omit to inherit every granted Tool; use [] for none.' },
    skills: { type: 'array' as const, items: { type: 'string' as const }, description: 'Granted child Skill ids. Omit to inherit every granted Skill; use [] for none.' },
    mcp_server_ids: { type: 'array' as const, items: { type: 'string' as const }, description: 'Granted MCP server ids. Omit to inherit every granted server; use [] for none.' },
    child_profile_ids: { type: 'array' as const, items: { type: 'string' as const }, description: 'Granted Child Profile ids this child may use for its own delegation. Omit to inherit all granted ids; use [] for none.' },
    workspace_cwd: { type: 'string' as const, description: 'Relative directory inside the parent workspace. Omit to inherit the parent cwd.' },
    max_depth: { type: 'number' as const, description: 'Non-negative child delegation-depth ceiling; cannot exceed the parent grant.' },
    max_tokens: { type: 'number' as const, description: 'Non-negative child token ceiling; cannot exceed the parent grant.' },
    model_route_priority: { type: 'number' as const, description: 'Model route priority.' },
    scheduler_priority: { type: 'number' as const, description: 'Scheduler priority.' },
    supervision_mode: { type: 'string' as const, description: 'Human-supervision mode fixed for this Child Profile: supervised or unsupervised.' },
  }
}

type ProfileToolArgs = {
  child_profile_id: string
  harness_id?: string
  model_route_id?: string
  tools?: string[]
  skills?: string[]
  mcp_server_ids?: string[]
  child_profile_ids?: string[]
  workspace_cwd?: string
  max_depth?: number
  max_tokens?: number
  model_route_priority?: number
  scheduler_priority?: number
  supervision_mode?: string
}

function profileSpecFromArgs(
  args: ProfileToolArgs,
  defaults: Pick<ChildProfileGrant, 'harnessIds' | 'modelRouteIds'>,
): ChildProfileSpec {
  if (args.supervision_mode !== undefined && args.supervision_mode !== 'supervised' && args.supervision_mode !== 'unsupervised') {
    throw new Error('supervision_mode must be "supervised" or "unsupervised"')
  }
  return {
    profileId: args.child_profile_id,
    harnessId: args.harness_id ?? defaults.harnessIds[0] as string,
    modelRouteId: args.model_route_id ?? defaults.modelRouteIds[0] as string,
    ...args.tools !== undefined ? { tools: args.tools } : {},
    ...args.skills !== undefined ? { skills: args.skills } : {},
    ...args.mcp_server_ids !== undefined ? { mcpServerIds: args.mcp_server_ids } : {},
    ...args.child_profile_ids !== undefined ? { childProfileIds: args.child_profile_ids } : {},
    ...args.workspace_cwd !== undefined ? { workspaceCwd: args.workspace_cwd } : {},
    ...args.max_depth !== undefined ? { maxDepth: args.max_depth } : {},
    ...args.max_tokens !== undefined ? { maxTokens: args.max_tokens } : {},
    ...args.model_route_priority !== undefined ? { modelRoutePriority: args.model_route_priority } : {},
    ...args.scheduler_priority !== undefined ? { schedulerPriority: args.scheduler_priority } : {},
    ...args.supervision_mode !== undefined ? { supervisionMode: args.supervision_mode } : {},
  }
}

/** Bind the current parent to the deployment-derived default Profile grant. */
function ensureParentProfileGrant(
  ctx: Context,
  parent: Agent,
  config: Config,
): ChildProfileGrant {
  const existing = ctx.subagents.getChildProfileGrant(parent)
  if (existing !== undefined) return existing
  const harnessId = config.provider
  const provider = parent.options.provider ?? config.agentOptions?.provider
  const model = parent.options.model ?? config.agentOptions?.model
  if (provider === undefined || model === undefined) {
    throw new Error('child_profile_define requires a parent with a resolved provider and model route')
  }
  const modelRouteId = `parent:${provider}:${model}`
  ctx.subagents.ensureChildModelRoute(modelRouteId, { provider, model })
  if (!ctx.subagents.hasChildProfileGrant(parent)) {
    const cwd = parent.session.header.cwd ?? process.cwd()
    const grant: ChildProfileGrant = {
      harnessIds: [harnessId],
      modelRouteIds: [modelRouteId],
      tools: ctx.tools.schemas(parent).map(schema => schema.name),
      skills: [],
      mcpServerIds: [],
      childProfileIds: [],
      workspaceRoot: cwd,
      parentWorkspaceCwd: cwd,
      ...typeof config.maxDepth === 'number' ? { maxDepth: config.maxDepth } : {},
    }
    ctx.subagents.registerChildProfileGrant(parent, grant)
  }
  return ctx.subagents.getChildProfileGrant(parent) as ChildProfileGrant
}

function profileGrantJson(grant: ChildProfileGrant): JsonValue {
  return {
    harnessIds: [...grant.harnessIds],
    modelRouteIds: [...grant.modelRouteIds],
    tools: [...grant.tools],
    skills: [...grant.skills],
    mcpServerIds: [...grant.mcpServerIds],
    childProfileIds: [...grant.childProfileIds],
    workspaceRoot: grant.workspaceRoot,
    parentWorkspaceCwd: grant.parentWorkspaceCwd,
    ...(grant.maxDepth === undefined ? {} : { maxDepth: grant.maxDepth }),
    ...(grant.maxTokens === undefined ? {} : { maxTokens: grant.maxTokens }),
  }
}

/** Resolve the model's optional scheduling request into one execution route. */
function resolveDelegationMode(
  request: DelegationRunRequest,
  backgroundEnabled: boolean,
  legacyOneShot: boolean,
): 'sync' | 'async' {
  if (request.mode === 'async' && !backgroundEnabled) {
    throw new Error('mode: async is disabled for this tool instance (enableRunInBackground: false)')
  }
  return request.mode ?? (legacyOneShot ? 'sync' : backgroundEnabled ? 'async' : 'sync')
}

export function apply(ctx: Context, config: Config): void {
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  // Reject an empty explicit filter at load instead of failing every delegation.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }
  const backgroundEnabled = config.enableRunInBackground !== false
  const toolName = config.toolName ?? 'subagent'
  // Mirror provider lifecycle because sibling load order and HMR replacement
  // can change provider availability while this fiber remains active.
  let disposeTool: (() => void) | undefined
  const mount = (provider: SubagentProvider): void => {
    // A numeric cap the provider cannot enforce is a misconfiguration — fail at
    // mount (the earliest point the provider's capabilities are known), not on
    // the first delegation.
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    const wording = providerWording(provider.inheritsParentContext)
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      description: wording.description + (backgroundEnabled
        ? ' This tool starts a durable continuable child Session asynchronously by default. This subagent lifecycle is not a generic background job: never pass its Session id to `job_output`, `job_list`, or `job_kill`. When the initial turn settles, the runtime sends the parent a notice containing its outcome and any final assistant message. Use `session_message` with that Session id for later turns and `session_inspect` to read the child state or transcript. Set `mode: sync` only when your next action depends on receiving the initial result.'
        : ' This tool starts a durable continuable child Session and waits for its initial result. This subagent lifecycle is not a generic background job: never pass its Session id to `job_output`, `job_list`, or `job_kill`. Use `session_message` and `session_inspect` with that Session id.'),
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription,
        },
        mode: {
          type: 'string' as const,
          enum: ['sync', 'async'] as const,
          description: 'Whether to wait for the child result (`sync`) or return after accepting its initial turn (`async`). Async returns a durable child Session, not a generic job id; use session controls rather than job tools. Omit to use this tool instance\'s advertised default.',
        },
        ...config.enableChildProfileDefine === true || config.enableChildProfileList === true ? {
          child_profile_id: {
            type: 'string' as const,
            description: 'Optional id from child_profile_list in this parent Agent\'s private Child Profile namespace. This is not an ordinary Agent Profile id.',
          },
        } : {},
      },
      output: {
        schema: {
          oneOf: [{
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true, const: 'async' },
              invocationId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
            },
          }, {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true, const: 'sync' },
              invocationId: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              output: { type: 'array', required: true, items: { type: 'json' } },
              legacy: { type: 'boolean', const: true },
            },
          }],
        },
        render: (_args, value) => [{
          type: 'text',
          text: renderInvocationResult(value),
        }],
        presentationMeta: (_args, value) => ({
          kind: 'subagent',
          childSessionId: value.sessionId,
          mode: value.mode,
          invocationId: value.invocationId,
        }),
      },
      // Children never mutate the parent session.
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if ('profile_id' in args) {
          throw new Error('profile_id was removed; use child_profile_id')
        }
        const parent = exec.agent
        if (!parent) {
          // Non-agent callers provide no parent for delegation ownership.
          throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        }

        const childProfile = args.child_profile_id === undefined
          ? undefined
          : ctx.subagents.getChildProfile(parent, args.child_profile_id)
        if (args.child_profile_id !== undefined && childProfile === undefined) {
          throw new Error(`no parent-private child profile named "${args.child_profile_id}"`)
        }
        const maxDepth = childProfile?.maxDepth
          ?? (typeof config.maxDepth === 'number' ? config.maxDepth : undefined)
        const profileAgentOptions = childProfile === undefined
          ? undefined
          : ctx.subagents.resolveChildModelRoute(childProfile)
        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
          parent,
          ...profileAgentOptions !== undefined
            ? { agentOptions: profileAgentOptions }
            : config.agentOptions !== undefined ? { agentOptions: config.agentOptions } : {},
          ...config.persona !== undefined ? { persona: config.persona } : {},
          ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
          ...maxDepth !== undefined ? { maxDepth } : {},
          ...childProfile !== undefined ? { childProfile } : {},
        }

        // oxlint-disable-next-line typescript/no-deprecated -- this branch is the compatibility owner for the legacy configuration key.
        const legacyOneShot = config.backgroundMode === 'one-shot'
        const mode = resolveDelegationMode(args, backgroundEnabled, legacyOneShot)
        if (mode === 'sync' && legacyOneShot) {
          // @deprecated Preserve the explicit legacy escape hatch while the
          // default Invocation path remains continuable for both wait modes.
          // oxlint-disable-next-line typescript/no-deprecated -- explicit legacy config selects this compatibility path.
          const run = await ctx.subagents.start(config.provider, {
            ...request,
            signal: exec.signal,
          })
          return await settleLegacyRun(run)
        }
        // Subagent lifecycles are Session/Invocation lifecycles, never generic
        // background jobs. Both waiting policies use the continuable path.
        const invocation = await ctx.subagents.invoke(config.provider, mode, {
          ...request,
          signal: exec.signal,
        })
        if (invocation.mode === 'async') {
          return {
            mode: 'async' as const,
            invocationId: invocation.invocationId,
            sessionId: invocation.sessionId,
          }
        }

        return await settleForegroundInvocation(invocation)
      },
    }))
  }

  // Register listeners before checking presence so no synchronous change is missed.
  // TODO(subagent-dup-toolname): two waiting fibers configured with the same
  // toolName collide when their provider appears, and the duplicate-name throw
  // rolls back the provider registration. Add an intent registry if the late
  // collision occurs in a shipped composition.
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount(present)
  } else {
    // A backend fiber may activate later; a misspelled provider remains visible in this log.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
  }
  if (backgroundEnabled) {
    // The section follows provider availability without its own manual
    // lifecycle: empty text is omitted from rendered prompts while the tool is
    // absent, and the registration itself stays owned by this plugin fiber.
    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: SUBAGENT_SECTION_ORDER,
      text: context => disposeTool === undefined || ctx.tools.get(toolName, context.scope) === undefined
        ? ''
        : `Use ${toolName} asynchronously by default. Start independent delegations together in one assistant message and continue useful work while they run. This subagent lifecycle is not a generic background job; never pass its Session id to job_output, job_list, or job_kill. The result identifies the durable child Session; use session_message with that session_id for later turns and session_inspect to read its state or transcript. Set \`mode: sync\` only when the next action depends on that subagent's initial result. When an asynchronous run settles, the runtime sends you a notice containing its outcome and any final assistant message.`,
    })
  }

  const profileToolDisposers: Array<() => void> = []
  if (config.enableChildProfileDefine === true) {
    profileToolDisposers.push(ctx.tools.register(defineTool({
      name: 'child_profile_define',
      description: 'Define or replace one complete Child Profile in the current parent Agent\'s private in-memory namespace. Omitted capability arrays inherit the full grant shown by child_profile_list; [] grants none. The host rejects capabilities outside that grant. Pass the returned profileId to subagent.child_profile_id.',
      parameters: profileParameters(),
      output: {
        schema: { type: 'json' as const },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (!exec.agent) throw new Error('child_profile_define requires a calling agent')
        const defaults = ensureParentProfileGrant(ctx, exec.agent, config)
        return await Promise.resolve(profileJson(
          ctx.subagents.defineChildProfile(exec.agent, profileSpecFromArgs(args, defaults)),
        ))
      },
    })))
  }
  if (config.enableChildProfileList === true) {
    profileToolDisposers.push(ctx.tools.register(defineTool({
      name: 'child_profile_list',
      description: 'Show the current parent Agent\'s available Child Profile grant and defined profile revisions. Profile definitions last for this live parent Agent; each started child durably retains its resolved immutable snapshot.',
      parameters: {},
      output: {
        schema: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            grant: { type: 'json' as const, required: true },
            profiles: { type: 'array' as const, required: true, items: { type: 'json' as const } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        if (!exec.agent) throw new Error('child_profile_list requires a calling agent')
        const grant = ensureParentProfileGrant(ctx, exec.agent, config)
        return await Promise.resolve({
          grant: profileGrantJson(grant),
          profiles: ctx.subagents.listChildProfiles(exec.agent).map(profileJson),
        })
      },
    })))
  }
  if (profileToolDisposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of profileToolDisposers) dispose()
    }, 'tool-subagent.profile-tools()')
  }
}
