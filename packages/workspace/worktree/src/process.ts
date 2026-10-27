/** Bounded, cancellable commands under the calling session's existing file policy. */

import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** Resolved process resource limits owned by the worktree service. */
export interface ProcessConfig {
  /** Deadline for one command, including executable lookup and confinement. */
  timeoutMs: number
  /** Termination grace period for each managed subprocess. */
  graceMs: number
  /** Maximum captured bytes per output stream. */
  maxOutputBytes: number
}

/** Clear inherited repository, attribute-tree, command-line configuration, and replacement-ref selectors. */
const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
].map(key => [key, undefined]))

/** One completed command with its bounded stdout. */
export interface CommandResult {
  /** Complete captured stdout, truncated to the configured cap from the tail. */
  stdout: string
  /** Process exit status; `null` only when the process could not be observed to exit. */
  exitCode: number | null
}

/**
 * Run an argv without a shell and await termination of its managed process range.
 * @param ctx - subprocess and sandbox providers in the same execution world.
 * @param config - complete process resource limits.
 * @param policy - unchanged calling session policy.
 * @param cwd - canonical process working directory.
 * @param argv - executable followed by literal arguments.
 * @param signal - operation cancellation.
 * @param allowedExitCodes - command-specific successful statuses.
 * @param env - command-local environment overrides, applied after Git selector removal.
 * @returns complete bounded stdout and the exit code.
 */
export async function runCommand(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  cwd: string,
  argv: readonly [string, ...string[]],
  signal: AbortSignal,
  allowedExitCodes: readonly number[] = [0],
  env: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  using timeout = deadline(signal, config.timeoutMs, 'WORKTREE_TIMEOUT')
  timeout.signal.throwIfAborted()
  const program = await ctx.subprocess.resolveExecutable(argv[0], undefined, timeout.signal)
  const command: [string, ...string[]] = [program, ...argv.slice(1)]
  const confined = policy.mode === 'danger-full-access'
    ? undefined
    : await ctx.sandbox.confine(command, {
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      ...policy.sessionId === undefined ? {} : { sessionId: policy.sessionId },
    }, timeout.signal)
  const wrapped = confined === undefined ? command : confined.argv
  timeout.signal.throwIfAborted()
  const child = ctx.subprocess.spawn({
    argv: wrapped,
    cwd,
    env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1', ...env },
    signal: timeout.signal,
    graceMs: config.graceMs,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.maxOutputBytes },
      stderr: { maxBytes: config.maxOutputBytes },
    },
  })
  const outcome = await child.done
  /* v8 ignore next -- collect-mode streams are structurally guaranteed by the spawn spec above */
  const stdout = child.collected.stdout?.readFrom(0).text ?? ''
  /* v8 ignore next -- a tree killed before observable exit surfaces through the caller's wrapped failure */
  if (outcome.exitCode === null) {
    throw new Error(`worktree command exited unobservably: ${argv[0]}`)
  }
  if (!allowedExitCodes.includes(outcome.exitCode)) {
    /* v8 ignore next -- collect-mode streams are structurally guaranteed by the spawn spec above */
    const stderr = child.collected.stderr?.readFrom(0).text ?? ''
    const detail = stderr.trim().length > 0 ? stderr.trim() : stdout.trim()
    throw new Error(
      `worktree command failed with exit code ${outcome.exitCode}: ${argv[0]} ${argv.slice(1).join(' ')}${detail.length > 0 ? `\n${detail}` : ''}`,
    )
  }
  return { stdout, exitCode: outcome.exitCode }
}
