/**
 * User-global rules contract: the read/write pair over the harness home's
 * `AGENTS.md` (the `user-global` instruction scope) for the settings panel.
 * Both methods authorize through the standard capability fence — read
 * observes, write mutates durable user state that steers every session.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Observation of the user-global rules file at one point in time. */
export interface GlobalRulesReadView {
  /** Whether the rules file exists on disk right now. */
  exists: boolean
  /** Full UTF-8 content; empty when the file does not exist. */
  content: string
  /** Content-derived freshness token; absent when the file does not exist. */
  version?: string
  /** Symbolic display path (`~/.dsh/AGENTS.md` or `$DSH_HOME/AGENTS.md`); never absolute. */
  displayPath: string
  /** Maximum UTF-8 byte count one write accepts. */
  maxBytes: number
}

/**
 * Host-facing user-global rules surface: one settings-page editor over the
 * file every session's baseline instructions load.
 */
export interface GlobalRulesApi {
  /**
   * Read the current rules file state (content, existence, freshness token,
   * display path, and the write cap the editor should enforce client-side).
   */
  read(request: RpcRequest<{}>): Promise<RpcResponse<GlobalRulesReadView>>

  /**
   * Persist full replacement content, creating the file when absent. Send the
   * token from the last read as `expectedVersion` to refuse overwriting a
   * concurrent external edit; omit it to write unconditionally.
   */
  write(request: RpcRequest<{
    /** Full replacement content, UTF-8. */
    content: string
    /** Freshness token the client last read; omit for an unconditional write. */
    expectedVersion?: string
  }>): Promise<RpcResponse<{ version: string }>>
}
