/**
 * Fresh-process ACP subagent client. Drives one child session and owns
 * cancellation and quiescent disposal; the protocol, the process transport,
 * and the teardown ladder belong to the ACP client core.
 *
 * TODO(acp-subagent-replay): add snapshot-tier coverage with a separate replay fixture and
 * sessions root inside each child process. Current keyless coverage uses a scripted ACP child;
 * with-key coverage drives the real ACP example.
 * @module @deepseek-ai/dsh-subagent-acp/run
 */

import { randomUUID } from 'node:crypto'
import {
  connectAcpAgent,
  policyAnswerer,
  type AcpConnection,
  type AcpContentBlock,
  type AcpPermissionPolicy,
  type AcpPromptBlock,
  type AcpSession,
  type AcpStopReason,
} from '@deepseek-ai/dsh-acp-client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AssistantOutputFold } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

export { DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS } from '@deepseek-ai/dsh-acp-client'

/** Fixed response to child permission requests: reject by default, or select the first allow option. */
export type PermissionPolicy = AcpPermissionPolicy

/** Resolved spawn spec for an ACP child process (no defaults — see Config). */
export interface AcpRunSpec {
  /** The executable to spawn (the child ACP agent). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /**
   * Absolute working directory for the child process AND its ACP session
   * `cwd`. The provider resolves it before this spec exists: config override,
   * else the delegating parent session's workspace.
   */
  cwd: string
  /** How to auto-answer the child's permission prompts. */
  permission: PermissionPolicy
  /**
   * Extra environment variables to ADD for the child (e.g. the child harness's
   * `DEEPSEEK_API_KEY`). Merged on top of the subprocess seam's scrubbed
   * parent env. A value here is forwarded even if its name matches the
   * credential-scrub pattern (an explicit opt-in for the child's own creds).
   * Explicit `DSH_*` entries are deployment-owned facts for the child harness
   * (e.g. `DSH_PERMISSION_MODE`); they simply merge after the scrub that
   * dropped their stale ambient namesakes.
   */
  env: Record<string, string>
  /**
   * Grace period (ms) for the child's EOF-driven quiesce in
   * {@link SubagentRun.dispose} — the window to flush persistence and tear down
   * its OWN nested subprocesses before the parent escalates to a signal. The
   * plugin fills this from its `disposeEofGraceMs` config.
   */
  disposeEofGraceMs: number
  /**
   * Termination-escalation grace (ms) in {@link SubagentRun.dispose}; POSIX
   * waits this long after `SIGTERM` before `SIGKILL`, while Windows
   * force-terminates directly. The plugin fills it from `disposeGraceMs`.
   */
  disposeGraceMs: number
  /**
   * Spawn function from the subprocess seam (`ctx.subprocess.spawn`), so the
   * child rides the shared scrub, tree-scoped teardown, and service-owned
   * lifetime instead of a package-local child_process path.
   */
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /**
   * Sink for a child-level failure that the run flattened into a stop reason
   * (the seam contract forbids `result` rejecting). The driver calls this with
   * the original error and the chosen stop reason so the fault is preserved
   * rather than silently lost; the provider wires it to `ctx.logger.warn`.
   * A throw from the sink itself is contained — it cannot reject `result`.
   * Optional — omitted in a unit test that asserts the stop reason directly.
   */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

const ABORTED_BEFORE_START = 'subagent request was aborted before the ACP child started'

/**
 * Map an ACP stop reason to a harness {@link SubagentStopReason}.
 * @param reason - the terminal reason from the child's turn.
 * @returns the harness equivalent; `max_turn_requests`, `error`, and any unknown
 *   reason map to `error`, so an unclean stop is never reported as `completed`.
 */
export function acpStopReason(reason: AcpStopReason): SubagentStopReason {
  switch (reason) {
    case 'end_turn':
      return 'completed'
    case 'max_tokens':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    case 'cancelled':
      return 'aborted'
    default:
      return 'error'
  }
}

/**
 * Collect the text of an ACP content block (non-text blocks contribute nothing).
 * @param content - the content block off a streamed message chunk.
 * @returns the block's text, or `''` for a non-text block.
 */
export function acpContentText(content: AcpContentBlock): string {
  return content.type === 'text' && typeof content.text === 'string' ? content.text : ''
}

/**
 * Translate the harness prompt blocks into ACP prompt blocks (text only).
 * @param prompt - the harness prompt; non-text blocks are dropped.
 * @returns the ACP text blocks, in order.
 */
export function toAcpPrompt(prompt: ContentBlock[]): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  for (const block of prompt) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
  }
  return blocks
}

/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value: unknown): Error {
  // The core reports its own `AcpError` subclasses; the `String(value)` arm is
  // a defensive fallback for a non-Error throw that the typed API cannot produce.
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

/** Reject as soon as `signal` aborts, so startup never waits on a slow agent. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error(ABORTED_BEFORE_START)) }, { once: true })
  })
}

/** Await one startup step, or fail it as soon as `signal` aborts. */
function raceAborted<T>(step: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([step, aborted(signal)])
}

/**
 * Start and publish one ACP child after initialization and session creation.
 * Child failures resolve through the run result; startup failures reject after
 * process reap. Disposal cancels, kills, and reaps the child.
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved spawn spec: command/args/cwd, env, permission
 * policy, dispose graces, and the optional error sink.
 * @returns the ready run handle for the child subprocess.
 */
export async function startAcpRun(request: SubagentStartRequest, spec: AcpRunSpec): Promise<SubagentRun> {
  if (request.signal.aborted) throw new Error(ABORTED_BEFORE_START)
  // ACP session ids are unique only within the child server. The lifecycle id
  // is minted in the parent namespace so fresh processes cannot collide with
  // each other or with a local agent that happens to use the same session id.
  const id = SessionId(randomUUID())
  // The request signal and disposal share one channel: either settles the run aborted.
  const lifetime = new AbortController()
  const signal = AbortSignal.any([request.signal, lifetime.signal])
  const fold = new AssistantOutputFold()
  // Read at every return so a partial answer survives a later cancel/error.
  const collectOutput = (): ContentBlock[] => fold.collect() ?? []

  // Keep diagnostics on parent stderr; only ACP output contributes to the
  // result. A failed handshake or spawn rejects after the core reaped the child.
  const connection: AcpConnection = await connectAcpAgent({
    definition: { command: spec.command, args: spec.args, env: spec.env },
    cwd: spec.cwd,
    spawn: spec.spawn,
    permission: policyAnswerer(spec.permission),
    disposeEofGraceMs: spec.disposeEofGraceMs,
    disposeGraceMs: spec.disposeGraceMs,
    signal,
  }).catch((error: unknown) => {
    // The core reaps the child before it rejects; a cancelled setup reports as the request's own abort.
    if (signal.aborted) throw new Error(ABORTED_BEFORE_START)
    throw error
  })
  let session: AcpSession
  try {
    session = await raceAborted(connection.newSession(), signal)
  } catch (error: unknown) {
    await connection.dispose()
    if (signal.aborted) throw new Error(ABORTED_BEFORE_START)
    throw error
  }

  const result: Promise<SubagentResult> = (async (): Promise<SubagentResult> => {
    try {
      // ACP exposes no complete assistant messages, so the shared fold selects
      // its accumulated assistant text; every other update is consumed unseen.
      const turn = session.prompt(toAcpPrompt(request.prompt), { signal })
      for await (const update of turn.updates) {
        if (update.kind === 'message-chunk') fold.pushText(acpContentText(update.content))
      }
      return { output: collectOutput(), stopReason: acpStopReason((await turn.end).stopReason) }
    } catch (error: unknown) {
      // Flatten post-publication failures while preserving diagnostics. A
      // cancellation never reaches here: it settles the turn as cancelled above.
      try {
        spec.onError?.(toError(error), 'error')
      } catch {
        // The diagnostic sink cannot reject the run result.
      }
      return { output: collectOutput(), stopReason: 'error' }
    }
  })()

  let disposal: Promise<void> | undefined
  return {
    id,
    localAgent: undefined,
    result,
    dispose(): Promise<void> {
      // Disposal is a local cancellation followed by the core's teardown ladder:
      // stdin EOF, its grace window, then the platform escalation to SIGKILL.
      lifetime.abort(new Error('subagent run disposed'))
      return (disposal ??= connection.dispose())
    },
  }
}
