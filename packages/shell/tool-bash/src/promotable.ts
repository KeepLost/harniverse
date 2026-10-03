/**
 * Foreground execution whose explicit timeout promotes instead of killing:
 * the tool races its own deadline against the live process, and on expiry
 * adopts the process as a background job so the command keeps running and
 * settles through the ordinary completion notice.
 *
 * @module @deepseek-ai/dsh-tool-bash/promotable
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellExecutor } from '@deepseek-ai/dsh-shell'
import { processOutcome } from './background.ts'
import { renderProcessRead } from './render.ts'

/** The result union the bash tool returns for a promotable foreground call. */
export type PromotableResult =
  | { kind: 'timeout-background'; jobId: string; timeoutMs: number }
  | {
    kind: 'foreground'
    exitCode: number | null
    signal: NodeJS.Signals | null
    timedOut: false
    aborted: boolean
    timeoutMs: number
    stdout: { text: string; truncated: boolean }
    stderr: { text: string; truncated: false }
    governor?: { killed: string; peakBytes?: number; limitBytes?: number }
  }

/** Inputs for one promotable foreground run. */
export interface PromotableInputs {
  readonly shell: ShellExecutor
  readonly request: ShellExecRequest
  readonly signal: AbortSignal
  readonly jobs: JobRegistry
  readonly command: string
  readonly agent: Agent | undefined
  readonly escalationModes: readonly SandboxMode[]
  readonly abortedError: () => Error
  /** Governor breach stamped on an in-budget completion, when a governor is mounted. */
  readonly breach: { killed: string; peakBytes?: number; limitBytes?: number } | undefined
}

/**
 * Run one explicitly timed-out command with promotion semantics: race the
 * process against the resolved timeout; expiry registers the live process as
 * a `bash` job and returns its id, an in-budget completion renders the
 * ordinary foreground result (stderr rides the process read's marked
 * section), and a caller abort kills the process and rethrows the abort.
 * @param inputs - shell, request, signals, jobs, and rendering inputs.
 * @returns the timeout-background receipt or the foreground result.
 */
export async function runPromotableForeground(inputs: PromotableInputs): Promise<PromotableResult> {
  const { shell, request, signal, jobs, command, agent, escalationModes, abortedError, breach } = inputs
  // The executor signal carries only the caller's abort; the timeout race is ours.
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort() }
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    const spec: ShellExecSpec = shell.resolve({ ...request, signal: controller.signal })
    const process: ShellProcess = await shell.start(spec)
    if (controller.signal.aborted) {
      process.kill()
      throw abortedError()
    }
    const done = process.done.then(() => 'done' as const)
    const expiry = new Promise<'expired'>((resolve) => {
      setTimeout(() => { resolve('expired') }, spec.timeoutMs)
    })
    const winner = await Promise.race([done, expiry])
    const callerAborted = (): boolean => controller.signal.aborted
    if (winner === 'expired' && !callerAborted()) {
      // Lost the race to our own deadline: adopt the live process as a job.
      const jobId = jobs.start({
        kind: 'bash',
        label: command,
        ...agent !== undefined ? { owner: agent } : {},
        run: () => ({
          cancel: () => process.kill(),
          done: process.done.then(() => processOutcome(process)),
          readOutput: () => renderProcessRead(process.readOutput(), process.sandbox, escalationModes),
        }),
      })
      return { kind: 'timeout-background', jobId, timeoutMs: spec.timeoutMs }
    }
    await process.done
    if (callerAborted()) throw abortedError()
    const read = process.readOutput()
    return {
      kind: 'foreground',
      exitCode: process.exitCode,
      signal: process.signal,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: read.delta, truncated: read.lossy },
      stderr: { text: '', truncated: false },
      ...breach !== undefined ? { governor: breach } : {},
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
