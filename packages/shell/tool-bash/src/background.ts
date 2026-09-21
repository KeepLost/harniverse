/**
 * Generic-task adaptation for background bash process handles.
 *
 * @module @deepseek-ai/dsh-tool-bash/background
 */

import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs'

/**
 * Keep job cancellation active while a remote shell is preparing its process.
 * @param start - resolves the process handle, honouring the abort signal when preparation is cancelled.
 * @param render - renders the process's current output snapshot for `readOutput`.
 * @returns the `ctx.jobs` hooks wired to the process lifetime.
 */
export function processJob(
  start: (signal: AbortSignal) => ShellProcess | Promise<ShellProcess>,
  render: (process: ShellProcess) => string,
): JobHooks {
  const controller = new AbortController()
  let process: ShellProcess | undefined
  const done: Promise<JobOutcome> = (async () => {
    try {
      process = await start(controller.signal)
      if (controller.signal.aborted) process.kill()
      await process.done
      return processOutcome(process)
    } catch (error) {
      return { status: controller.signal.aborted ? 'killed' : 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
  })()
  return {
    cancel: (reason) => { controller.abort(reason); process?.kill() },
    done,
    readOutput: () => process === undefined ? '' : render(process),
  }
}

/**
 * Map a settled background process onto the generic task-outcome vocabulary:
 * `killed` stays `killed` (detail: the signal when one is known), everything
 * else is `completed` with the exit code as detail. A nonzero command exit is
 * reported, not failed, exactly like the foreground rendering.
 * @param proc - the settled process handle.
 * @returns the outcome for the `ctx.jobs` registration.
 */
export function processOutcome(proc: ShellProcess): { status: 'completed' | 'killed'; detail: string } {
  // TODO(background-infrastructure-outcome): widen ShellProcess with an explicit
  // infrastructure-failure outcome, then map it to task `failed`. Restricted
  // runner failures expose sandbox.runnerFailed, but unconfined spawn failures
  // still alias a signal-less kill; real nonzero command exits must remain
  // `completed`.
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}
