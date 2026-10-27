/**
 * Derive the workspace root an `lsp` call resolves against: the calling agent's effective
 * session directory (the working-directory owner's committed value, falling back to the
 * immutable header cwd), mirroring how the filesystem tools resolve paths.
 * Unlike those tools, LSP has NO provider fallback — a missing cwd fails the call as
 * `LSP_WORKSPACE_REQUIRED`, because the local provider must canonicalize a real workspace before it
 * can start a server.
 * @module @deepseek-ai/dsh-tool-lsp/session-cwd
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { effectiveCwd } from '@deepseek-ai/dsh-working-directory'

/**
 * The effective session directory for this call, or `undefined` when none applies.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's effective directory, or undefined for a non-agent caller.
 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  return effectiveCwd(exec.agent)
}
