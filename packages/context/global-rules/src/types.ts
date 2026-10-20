/**
 * Service shapes for the user-global rules editor. Types only — the provider
 * lives in `index.ts` and Consumers adapt these views to their own surfaces.
 *
 * @module @deepseek-ai/dsh-global-rules/types
 */

/** Observation of the user-global rules file at one point in time. */
export interface GlobalRulesFileView {
  /** Whether the rules file exists on disk right now. */
  readonly exists: boolean
  /** Full UTF-8 content; empty when the file does not exist. */
  readonly content: string
  /**
   * Content-derived freshness token (a sha256 prefix). Echo it back on write
   * for optimistic conflict detection; undefined when the file does not exist.
   */
  readonly version: string | undefined
  /** Symbolic display path (`~/.dsh/AGENTS.md` or `$DSH_HOME/AGENTS.md`); never absolute. */
  readonly displayPath: string
  /** Maximum UTF-8 byte count one write accepts (mirrors the instruction loader's per-file cap). */
  readonly maxBytes: number
}

/** Outcome of one write attempt. */
export type GlobalRulesWriteResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: 'conflict'; readonly version: string | undefined }
  | { readonly ok: false; readonly reason: 'too-large' }

/** Read/write face over the harness-home `AGENTS.md`. */
export interface GlobalRules {
  /** Symbolic display path of the edited file; never an absolute machine path. */
  readonly displayPath: string
  /** Maximum UTF-8 byte count one write accepts. */
  readonly maxBytes: number
  /**
   * Observe the current file state.
   * @returns the file's content, existence, freshness token, and limits.
   * @throws when the filesystem read fails for a reason other than absence.
   */
  read(): Promise<GlobalRulesFileView>
  /**
   * Persist new content, creating the file (and the harness home) when absent.
   * @param content - full replacement content, UTF-8.
   * @param expectedVersion - token the caller last observed; a mismatch refuses
   * the write so concurrent external edits are not silently clobbered. Omit it
   * to write unconditionally.
   * @returns the write outcome with the new (or conflicting) freshness token.
   * @throws when the filesystem write fails.
   */
  write(content: string, expectedVersion?: string): Promise<GlobalRulesWriteResult>
}
