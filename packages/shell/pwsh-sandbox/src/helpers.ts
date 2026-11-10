/**
 * Internal sandbox-result classification helpers — the pwsh twin of
 * `@deepseek-ai/dsh-bash-sandbox/src/helpers.ts`; both re-export the shared
 * sandbox diagnostics and keep only their shell-adapter denial check.
 *
 * @module @deepseek-ai/dsh-pwsh-sandbox/helpers
 */

/* jscpd:ignore-start -- deliberate call-for-call mirror of the bash twin (shared classification dialect). */
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { matchesSignature } from '@deepseek-ai/dsh-sandbox'

export { classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'
export type { RunnerFailureMatch } from '@deepseek-ai/dsh-sandbox'

/**
 * Classify a failed run against the selected backend's denial dialect.
 * @param result - settled foreground run.
 * @param signatures - case-insensitive denial substrings from the active wrap.
 * @returns whether the failed run matches that denial dialect.
 */
export function classifyDenial(result: ShellRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}
/* jscpd:ignore-end */
