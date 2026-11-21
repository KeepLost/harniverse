/**
 * Out-of-process peer subagent backend: each delegated run starts one fresh
 * session on a single paired Harniverse instance over the pairing channel.
 * The child lives in another deployment with its own model, tools, and
 * governance, so this provider advertises no parent-enforced start
 * capabilities and supports no continuable children — the service rejects
 * both loud before any wire call. This plugin uses named exports only; a
 * default would hide its loader metadata
 * (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-subagent-peer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ensureInstanceIdentity, PeerError } from '@deepseek-ai/dsh-peer-protocol'
import {
  ensurePeerIdentityKey,
  peerFailureMessage,
  readPeerTargets,
  runPeerDelegate,
  selectPeerTarget,
  withPeerTransport,
} from '@deepseek-ai/dsh-peer-client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

/** Hard prompt bound shared with the accepting host's payload validation. */
const PROMPT_MAX_LENGTH = 32_768
/** Hard settlement-budget ceiling the accepting host enforces. */
const SETTLE_MAX_MS = 900_000
/** Per-call transport timeout ceiling keeping long budgets usable. */
const CALL_MAX_MS = 120_000
/** Minimum settlement budget; shorter budgets round the call unusable. */
const SETTLE_MIN_MS = 1_000

/** The stop reasons the peer channel's turn-end vocabulary shares with the seam. */
const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set(['completed', 'aborted', 'error', 'max-tokens', 'refusal'])

export const name = 'subagent-peer'
export const inject = ['subagents']

/** Config: which paired instance every delegation of this backend targets. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `peer`). */
  providerName: string
  /**
   * The paired instance every run delegates to: its exact instance id or its
   * exact display name in this home's pairing-target store. Resolution happens
   * per run, so a target paired after boot is picked up without a reload.
   */
  peerTarget: string
  /** Harness home of this instance holding the pairing target store. */
  dshHome?: string
  /** Settlement budget per delegated turn, in milliseconds (default 120000). */
  settleTimeoutMs?: number
}

/** Loader validation for the backend row. */
export const Config: z<Config> = z.object({
  providerName: z.string().default('peer'),
  peerTarget: z.string().required(),
  dshHome: z.string(),
  settleTimeoutMs: z.natural().min(SETTLE_MIN_MS).default(120_000),
})

/** The shape after schemastery applied the defaults (dshHome has none). */
type ResolvedConfig = Required<Pick<Config, 'providerName' | 'peerTarget' | 'settleTimeoutMs'>> & Pick<Config, 'dshHome'>

/**
 * Flatten one delegated prompt for the peer channel: text blocks concatenate
 * in order; any other block type cannot cross the text-only delegation wire
 * and rejects before a session exists.
 * @param blocks - the request's prompt content.
 * @returns the concatenated prompt text.
 */
function delegatablePrompt(blocks: readonly ContentBlock[]): string {
  let prompt = ''
  for (const block of blocks) {
    if (block.type !== 'text') {
      throw new Error(`subagent-peer: only text prompt blocks are delegatable over the peer channel (received "${block.type}")`)
    }
    prompt += block.text
  }
  if (prompt.length === 0) {
    throw new Error('subagent-peer: a delegated prompt must not be empty')
  }
  if (prompt.length > PROMPT_MAX_LENGTH) {
    throw new Error(`subagent-peer: prompt exceeds ${String(PROMPT_MAX_LENGTH)} characters`)
  }
  return prompt
}

/**
 * Map one settled peer turn onto the seam's result vocabulary: a shared
 * turn-end reason passes through, an unknown reason flattens to `error` with
 * the raw reason as diagnostic, and a settled turn without a reason counts as
 * completed.
 * @param outcome - the validated wire readback of the delegated turn.
 * @returns the terminal subagent result.
 */
function subagentResultOf(outcome: { sessionId: string; reply?: string; endReason?: string }): SubagentResult {
  const output = outcome.reply === undefined || outcome.reply.length === 0
    ? []
    : [{ type: 'text' as const, text: outcome.reply }]
  if (outcome.endReason === undefined || outcome.endReason === 'completed') {
    return { output, stopReason: 'completed' }
  }
  if (KNOWN_STOP_REASONS.has(outcome.endReason)) {
    return { output, stopReason: outcome.endReason as SubagentStopReason }
  }
  return {
    output,
    stopReason: 'error',
    diagnostic: `peer session ${outcome.sessionId} ended: ${outcome.endReason}`,
  }
}

/** The settled-or-failed outcome of one delegated wire turn. */
type PeerOutcome = SubagentResult & { readonly peerSessionId: string }

/**
 * The peer subagent backend: a one-shot transport whose child session lives
 * on the paired instance. The turn settles inside `start()` — the single
 * delegate RPC both submits the prompt and awaits its first settlement — so
 * fulfillment is publication: the returned run's `id` is the peer session id,
 * which stays continuable through the `peer` model tool.
 */
class PeerSubagentProvider implements SubagentProvider {
  readonly capabilities = NO_START_CAPABILITIES
  // Context contract: a remote child starts fresh on its own deployment — no
  // parent conversation crosses the pairing channel.
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly home: string,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const prompt = delegatablePrompt(request.prompt)
    const outcome = await this.settle(request.signal, () => this.delegateTurn(request, prompt))
    return {
      id: SessionId(outcome.peerSessionId),
      localAgent: undefined,
      result: Promise.resolve({
        output: outcome.output,
        ...outcome.diagnostic === undefined ? {} : { diagnostic: outcome.diagnostic },
        stopReason: outcome.stopReason,
      }),
      // The peer turn already settled when the run published, and local
      // cancellation cannot reach another deployment's in-flight work, so
      // disposal has no remaining local work to cancel.
      dispose: async () => {},
    }
  }

  /** Run one delegated wire turn to its settlement readback. */
  private async delegateTurn(request: SubagentStartRequest, prompt: string): Promise<PeerOutcome> {
    const target = selectPeerTarget(await readPeerTargets(this.home), this.config.peerTarget)
    const identity = await ensureInstanceIdentity(this.home)
    const key = await ensurePeerIdentityKey(this.home)
    const budget = Math.min(Math.max(this.config.settleTimeoutMs, SETTLE_MIN_MS), SETTLE_MAX_MS)
    const call = { instanceId: identity.instanceId, key }
    const run = async (origin: string) => runPeerDelegate(
      { target, home: this.home, origin, timeoutMs: Math.min(budget, CALL_MAX_MS) }, call, prompt, { timeoutMs: budget },
    )
    let readback
    try {
      readback = await withPeerTransport(this.ctx, this.home, target, run)
    } catch (error: unknown) {
      /* v8 ignore start -- the PeerError arm rewrites the closed reason wording;
         peer-client's typed surfaces cannot throw the non-peer arm */
      if (error instanceof PeerError) {
        throw new Error(`subagent-peer: ${peerFailureMessage(error)}`)
      }
      throw error as Error
      /* v8 ignore stop */
    }
    request.signal.throwIfAborted()
    if (readback.state === 'running') {
      return {
        peerSessionId: readback.sessionId,
        output: [],
        stopReason: 'error',
        diagnostic: `peer session ${readback.sessionId} is still running past the ${String(budget)}ms settlement budget; continue it with the peer tool`,
      }
    }
    return { peerSessionId: readback.sessionId, ...subagentResultOf(readback) }
  }

  /**
   * Await one delegated attempt while the caller's cancellation can still
   * reject before publication. A pre-publication abort rejects `start` before
   * dialing (the seam's partial-resource contract); an abandoned wire turn
   * keeps running on the peer and consumes its own budget — local
   * cancellation cannot reach another deployment's work.
   * @param signal - the request's cancellation signal.
   * @param begin - starts the delegated wire turn on first await.
   * @returns the attempt's settled outcome.
   */
  private async settle<T>(signal: AbortSignal, begin: () => Promise<T>): Promise<T> {
    let attempt: Promise<T> | undefined
    let detachAbortWatch: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => { reject(new Error('subagent-peer: delegation aborted before the peer turn settled')) }
      signal.addEventListener('abort', onAbort, { once: true })
      detachAbortWatch = () => { signal.removeEventListener('abort', onAbort) }
    })
    try {
      signal.throwIfAborted()
      attempt = begin()
      return await Promise.race([attempt, aborted])
    } finally {
      detachAbortWatch?.()
      // Silence whichever promise lost the race; its settlement is unowned.
      attempt?.catch(() => {})
      aborted.catch(() => {})
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field; the
  // assertion records that resolution, not a hidden fallback.
  const resolved = config as ResolvedConfig
  if (resolved.peerTarget === '') {
    throw new Error('subagent-peer: peerTarget must not be empty — name the paired instance every delegation targets')
  }
  ctx.subagents.registerProvider(new PeerSubagentProvider(
    resolved.providerName,
    ctx,
    resolveDshHome(resolved.dshHome),
    resolved,
  ))
}
