/**
 * One-shot Claude Code lifecycle: invoke the official Agent SDK, place its
 * real CLI process under the shared subprocess owner, map only strict SDK
 * success to completion, and dispose to whole-tree quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/run
 */

import { randomUUID } from 'node:crypto'
import {
  query as officialQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
} from './process.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

type ClaudeCodeFailureStage = 'query-run' | 'process'

type ClaudeCodeFailureCategory =
  | Exclude<SDKResultMessage['subtype'], 'success'>
  | 'invalid-success'
  | 'missing-result'
  | 'process-exit'
  | 'unknown'

interface ClaudeCodeFailureFacts {
  readonly stage: ClaudeCodeFailureStage
  readonly category: ClaudeCodeFailureCategory
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: ClaudeCodeFailureFacts): string {
  const fields = [
    'product: Claude Code',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  const exitCode = facts.outcome?.exitCode
  if (exitCode !== null && exitCode !== undefined) {
    fields.push(`exit code: ${exitCode}`)
  }
  const signal = facts.outcome?.signal
  if (signal !== null && signal !== undefined) fields.push(`signal: ${signal}`)
  return `Product subagent failure (${fields.join('; ')})`
}

class ClaudeCodeFailure extends Error {
  constructor(
    readonly facts: ClaudeCodeFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-claude-code: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'ClaudeCodeFailure'
  }
}

function sdkFailureCategory(
  subtype: string,
): Exclude<SDKResultMessage['subtype'], 'success'> | 'unknown' {
  switch (subtype) {
    case 'error_during_execution':
    case 'error_max_turns':
    case 'error_max_budget_usd':
    case 'error_max_structured_output_retries':
      return subtype
    default:
      return 'unknown'
  }
}

function unattendedDiagnostic(
  request: 'tool permission' | 'MCP elicitation' | 'user dialog',
  decision: 'denied' | 'declined' | 'cancelled',
): string {
  return `Claude Code unattended decision (request: ${request}; decision: ${decision})`
}

/* jscpd:ignore-start -- sibling providers intentionally keep product-private
 * run inputs and error normalization instead of adding a shared lifecycle owner. */
/** Fully resolved inputs for one official Claude Agent SDK query. */
export interface ClaudeCodeRunSpec {
  /** Parent Session workspace supplied to the SDK and real CLI. */
  readonly cwd: string
  /** Exact native Claude Code executable resolved from the host PATH. */
  readonly executable: string
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed SDK and subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}
/* jscpd:ignore-end */

/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one SDK prompt.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-claude-code: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Strictly derive the only SDK result that can complete a shared run.
 * @param message - an official discriminated result union.
 * @returns exact final text for a successful, non-error result.
 */
export function successfulResult(message: SDKResultMessage): string {
  if (message.subtype !== 'success') {
    const category = sdkFailureCategory(message.subtype)
    const detail = category === 'unknown' ? undefined : message.errors.join('; ')
    throw new ClaudeCodeFailure(
      { stage: 'query-run', category },
      detail === undefined || detail.length === 0 ? undefined : new Error(detail),
    )
  }
  if (message.is_error || message.result.trim().length === 0) {
    throw new ClaudeCodeFailure({
      stage: 'query-run',
      category: 'invalid-success',
    })
  }
  return message.result
}

/**
 * Consume the complete SDK stream and require one strict success plus normal
 * iterator completion.
 * @param query - published official SDK query.
 * @param onPermissionDenied - optional safe observation of a native permission denial.
 * @param onResult - optional observation that a terminal SDK result was received.
 * @returns the completed shared result.
 */
export async function consumeClaudeQuery(
  query: AsyncIterable<SDKMessage>,
  onPermissionDenied?: () => void,
  onResult?: () => void,
): Promise<SubagentResult> {
  let answer: string | undefined
  for await (const message of query) {
    if (message.type === 'system' && message.subtype === 'permission_denied') {
      onPermissionDenied?.()
      continue
    }
    if (message.type !== 'result') continue
    onResult?.()
    answer = successfulResult(message)
  }
  if (answer === undefined) {
    throw new ClaudeCodeFailure({
      stage: 'query-run',
      category: 'missing-result',
    })
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

/**
 * Close the official query, terminate the managed process tree, and wait for
 * the subprocess owner to prove it is gone.
 * @param query - official SDK query, when creation reached that point.
 * @param child - shared-service handle that owns the CLI process tree.
 */
export async function disposeClaudeCodeChild(
  query: Pick<Query, 'close'> | undefined,
  child: SubprocessHandle,
): Promise<void> {
  const failures: Error[] = []
  try {
    query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  if (child.pid > 0) {
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
  }
  try {
    await child.done
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  const firstFailure = failures[0]
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'subagent-claude-code: query and process cleanup failed',
    )
  }
}

/**
 * Build the fixed official SDK options for one one-shot provider run.
 * @param spec - Workspace, environment, process service, and disposal policy.
 * @param controller - per-run cancellation owner.
 * @param capture - receives the real managed child synchronously from the SDK hook.
 * @param captureDiagnostic - receives safe unattended interaction decisions.
 * @returns options that inherit native settings while disabling persistence and user questions.
 */
export function claudeQueryOptions(
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  capture: (
    child: SubprocessHandle,
    process: ManagedClaudeCodeProcess,
  ) => void,
  captureDiagnostic: (diagnostic: string) => void = () => {},
): Options {
  return {
    abortController: controller,
    cwd: spec.cwd,
    pathToClaudeCodeExecutable: spec.executable,
    env: { ...scrubbedParentEnv(), ...spec.env },
    persistSession: false,
    disallowedTools: ['AskUserQuestion'],
    canUseTool: () => {
      captureDiagnostic(unattendedDiagnostic('tool permission', 'denied'))
      return Promise.resolve({
        behavior: 'deny' as const,
        message: 'This unattended Claude Code subagent cannot request human approval.',
      })
    },
    onElicitation: () => {
      captureDiagnostic(unattendedDiagnostic('MCP elicitation', 'declined'))
      return Promise.resolve({ action: 'decline' })
    },
    onUserDialog: () => {
      captureDiagnostic(unattendedDiagnostic('user dialog', 'cancelled'))
      return Promise.resolve({ behavior: 'cancelled' as const })
    },
    supportedDialogKinds: ['refusal_fallback_prompt'],
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
      const process = new ManagedClaudeCodeProcess(child)
      capture(child, process)
      return process
    },
  }
}

/**
 * Start one official Claude Agent SDK query and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after both Query and real CLI handle exist.
 */
export async function startClaudeCodeRun(
  request: SubagentStartRequest,
  spec: ClaudeCodeRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-claude-code: request was aborted before SDK startup')
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-claude-code: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let child: SubprocessHandle | undefined
  let query: Query | undefined
  let managedProcess: ManagedClaudeCodeProcess | undefined
  let diagnostic: string | undefined
  const captureDiagnostic = (value: string): void => { diagnostic = value }
  const prependFailureDiagnostic = (facts: ClaudeCodeFailureFacts): void => {
    const failure = failureDiagnostic(facts)
    diagnostic = diagnostic === undefined ? failure : `${failure}\n${diagnostic}`
  }
  try {
    query = officialQuery({
      prompt,
      options: claudeQueryOptions(spec, controller, (captured, process) => {
        child = captured
        managedProcess = process
      }, captureDiagnostic),
    })
    if (child === undefined || child.pid <= 0) {
      throw new Error(
        'subagent-claude-code: official SDK did not publish a controllable Claude Code process',
      )
    }
    if (controller.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeClaudeCodeChild(query, child)
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and CLI cleanup also failed',
        )
      }
    } else if (query !== undefined) {
      try {
        query.close()
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and query cleanup also failed',
        )
      }
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- cancellation can occur while the awaited child/query cleanup runs.
    if (cancelledBeforeCleanup || request.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
    throw thrown(error)
  }

  const publishedQuery = query
  const publishedChild = child
  let receivedResult = false
  const result = settleRunResult({
    attempt: async () => {
      try {
        return await consumeClaudeQuery(publishedQuery, () => {
          captureDiagnostic(unattendedDiagnostic('tool permission', 'denied'))
        }, () => {
          receivedResult = true
        })
      } catch (error: unknown) {
        const outcome = managedProcess?.outcome
        let facts: ClaudeCodeFailureFacts
        if (error instanceof ClaudeCodeFailure) {
          facts = { ...error.facts, outcome }
        } else if (outcome !== undefined && !receivedResult) {
          facts = { stage: 'process', category: 'process-exit', outcome }
        } else {
          facts = { stage: 'query-run', category: 'unknown', outcome }
        }
        prependFailureDiagnostic(facts)
        throw error instanceof ClaudeCodeFailure
          ? error
          : new ClaudeCodeFailure(facts, thrown(error))
      }
    },
    collectOutput: () => [],
    collectDiagnostic: () => diagnostic,
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeClaudeCodeChild(
      publishedQuery,
      publishedChild,
    ),
  })
}
