/**
 * Internal sandbox-result classification helpers.
 *
 * @module @deepseek-ai/dsh-bash-sandbox/helpers
 */

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
