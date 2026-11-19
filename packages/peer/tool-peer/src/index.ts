/**
 * The model-facing `peer` tool: run one prompt on a paired Harniverse instance and
 * return the settled reply, or continue an existing delegated session. It owns the
 * model-facing schema and result rendering; target resolution, request proofs, and
 * transport dialing live in `@deepseek-ai/dsh-peer-client`, so the pairing channel
 * hardens without touching what the model sees. A turn still running past the budget
 * returns continuation guidance naming the session id; asynchronous receipt and
 * settlement push remain deferred to the initiator outbox.
 * @module @deepseek-ai/dsh-tool-peer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ensureInstanceIdentity, PeerError } from '@deepseek-ai/dsh-peer-protocol'
import {
  ensurePeerIdentityKey,
  readPeerTargets,
  runPeerDelegate,
  runPeerFollowup,
  withPeerTransport,
} from '@deepseek-ai/dsh-peer-client'
import type { PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Declaration merge only: makes ctx.systemPrompt visible for the section registration.
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Hard prompt bound shared with the accepting host's payload validation. */
const PROMPT_MAX_LENGTH = 32_768
/** Hard settlement-budget ceiling the accepting host enforces. */
const SETTLE_MAX_MS = 900_000
/** Per-call transport timeout ceiling keeping long budgets usable. */
const CALL_MAX_MS = 120_000

/** Stable Cordis plugin name. */
export const name = 'tool-peer'

/** Tool registration plus the usage-policy prompt section. */
export const inject = ['tools', 'systemPrompt']

/** Peer tool configuration. */
export interface Config {
  /** The model-facing tool name to register (default `peer`). */
  toolName?: string
  /** Harness home of this instance holding the pairing target store. */
  dshHome?: string
  /** Default settlement budget per turn, in milliseconds (default 120000). */
  defaultTimeoutMs?: number
  /** Rendered-reply ceiling, in characters: a longer reply is truncated with a notice (default 50000). */
  maxResultChars?: number
}

/** Loader validation for the tool row. */
export const Config: z<Config> = z.object({
  toolName: z.string().default('peer'),
  dshHome: z.string(),
  defaultTimeoutMs: z.natural().min(1_000).default(120_000),
  maxResultChars: z.natural().min(1).default(50_000),
})

type ResolvedConfig = Required<Pick<Config, 'toolName' | 'defaultTimeoutMs' | 'maxResultChars'>> & Pick<Config, 'dshHome'>

type PeerCallArgs = {
  target: string
  prompt: string
  session?: string
  timeoutMs?: number
}

/** The structured outcome the loop records and the renderer narrates. */
interface PeerToolValue {
  sessionId: string
  state: 'settled' | 'running'
  reply?: string
  endReason?: string
}

/** The model-facing contract, embedded in the tool description. */
const DESCRIPTION = `Run a prompt on a paired Harniverse instance — another machine this deployment is paired with — and return its settled reply. Use this when the user asks to delegate work to a paired instance by name, or to continue a delegated conversation started earlier.

Pass \`target\` as the instance's display name or its instance id; an exact instance id always wins. The first call starts a fresh delegated session and returns its \`sessionId\`; continue that conversation by passing \`session\` with the next prompt. Each turn waits up to \`timeoutMs\` (default 120000, max 900000) for settlement — a turn still running past the budget reports \`running\` with the \`sessionId\`; re-check later by continuing that session with a short status prompt.

The reply mirrors what the delegated instance's model produced. Failures name the closed peer reason (for example SESSION_NOT_FOUND for unknown sessions, TRANSPORT_FAILED when the instance is unreachable).`

/**
 * Resolve one stored active target by instance id or exact display name.
 * @param targets - stored pairing targets.
 * @param selector - model-provided target selector.
 * @returns the unique matching active target record.
 */
function resolveTarget(targets: readonly PeerTarget[], selector: string): PeerTarget {
  const active = targets.filter(target => target.status === 'active')
  const byId = active.filter(target => target.targetInstanceId === selector)
  if (byId.length === 1) return byId[0] as PeerTarget
  const byName = active.filter(target => target.displayName === selector)
  if (byId.length === 0 && byName.length === 1) return byName[0] as PeerTarget
  const catalog = active.length === 0
    ? 'no paired instances are recorded'
    : `paired instances: ${active.map(target => `${target.displayName} (${target.targetInstanceId})`).join(', ')}`
  if (byId.length === 0 && byName.length > 1) {
    throw new Error(`peer: ${JSON.stringify(selector)} matches several instances; pass an exact instance id — ${catalog}`)
  }
  throw new Error(`peer: no paired instance matches ${JSON.stringify(selector)} — ${catalog}`)
}

/** Render the settled or running narration, truncating oversized replies.
 * @param args - the validated call arguments.
 * @param value - the structured outcome.
 * @param maxChars - rendered-reply ceiling.
 * @returns the model-visible text.
 */
function renderValue(args: PeerCallArgs, value: PeerToolValue, maxChars: number): string {
  if (value.state === 'running') {
    return `Delegated session ${value.sessionId} on ${args.target} is still running. Continue it later by calling this tool with session ${JSON.stringify(value.sessionId)} and a short status prompt.`
  }
  const reply = value.reply ?? ''
  const clipped = reply.length > maxChars
    ? `${reply.slice(0, maxChars)}\n… [truncated: ${reply.length - maxChars} more characters]`
    : reply
  return `Delegated session ${value.sessionId} on ${args.target} replied:\n\n${clipped}`
}

/** The pending-state card: a generic card titled by the selected target. */
function presentPeerCall(args: PeerCallArgs): ToolCallView {
  return {
    card: 'generic',
    title: `peer: ${args.target}`,
    rawInput: args.prompt,
  }
}

/** The completed-state card: keep the pending title. */
function presentPeerResult(): ToolResultView {
  return { card: 'generic' }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (the exported Config schema) has already filled the defaulted
  // fields; the assertion records that resolution, not a hidden fallback.
  const { toolName, defaultTimeoutMs, maxResultChars } = config as ResolvedConfig
  const home = resolveDshHome(config.dshHome)
  // Usage policy ships with the tool (the master convention: tool guidance
  // lives in tool plugins as prompt sections, not in the deployment persona).
  ctx.systemPrompt.section({
    name: `tool:${toolName}`,
    order: 117,
    text: `Use the ${toolName} tool ONLY when the user explicitly asks to delegate work to a paired instance: it runs a prompt on another paired machine and returns that machine's reply. Do not use it for local work, and do not pick a target the user did not name.`,
  })
  ctx.tools.register(defineTool({
    name: toolName,
    description: DESCRIPTION,
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'The paired instance to address: its display name or exact instance id.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The prompt to run on the paired instance (at most 32768 characters).',
      },
      session: {
        type: 'string',
        description: 'Existing delegated session id to continue; omit to start a fresh session.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Settlement budget for this turn in milliseconds (default 120000, max 900000).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          reply: { type: 'string' },
          endReason: { type: 'string' },
        },
      },
      render: (args: PeerCallArgs, value: PeerToolValue): ContentBlock[] => [{
        type: 'text',
        text: renderValue(args, value, maxResultChars),
      }],
    },
    async execute(args: PeerCallArgs): Promise<PeerToolValue> {
      if (args.prompt.length > PROMPT_MAX_LENGTH) {
        throw new Error(`peer: prompt exceeds ${String(PROMPT_MAX_LENGTH)} characters`)
      }
      const target = resolveTarget(await readPeerTargets(home), args.target)
      const identity = await ensureInstanceIdentity(home)
      const key = await ensurePeerIdentityKey(home)
      const budget = Math.min(Math.max(args.timeoutMs ?? defaultTimeoutMs, 1_000), SETTLE_MAX_MS)
      const callTimeout = Math.min(Math.max(budget, 1_000), CALL_MAX_MS)
      const call = { instanceId: identity.instanceId, key }
      const run = async (origin: string) => args.session === undefined
        ? runPeerDelegate(
          { target, home, origin, timeoutMs: callTimeout }, call, args.prompt, { timeoutMs: budget },
        )
        : runPeerFollowup(
          { target, home, origin, timeoutMs: callTimeout }, call, args.session, args.prompt, budget,
        )
      let result
      try {
        result = await withPeerTransport(ctx, home, target, run)
      } catch (error: unknown) {
        if (error instanceof PeerError) {
          // PeerError messages always read `peer: <REASON>` plus an optional detail in parentheses.
          const detail = error.message.slice(`peer: ${error.reason}`.length).replace(/^ \(|\)$/g, '')
          throw new Error(`peer call failed (${error.reason})${detail === '' ? '' : `: ${detail}`}`)
        }
        throw error as Error
      }
      if (result.state === 'settled' && result.endReason !== undefined && result.endReason !== 'completed') {
        throw new Error(`peer: delegated turn ${result.sessionId} ended ${result.endReason}`)
      }
      return {
        sessionId: result.sessionId,
        state: result.state,
        ...result.reply !== undefined ? { reply: result.reply } : {},
        ...result.endReason !== undefined ? { endReason: result.endReason } : {},
      }
    },
    presentCall: args => presentPeerCall(args),
    presentResult: () => presentPeerResult(),
  }))
}
