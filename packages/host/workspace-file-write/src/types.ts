/**
 * Public wire vocabulary of the workspace file-editing Remote: open results,
 * version probes, save requests/results, and the stable failure codes the
 * client discriminates on. Types only — no runtime code.
 * @module @deepseek-ai/dsh-workspace-file-write/types
 */

/** Stable failure codes {@link WorkspaceFileWriteFailure} discriminates on. */
export type WorkspaceFileWriteErrorCode =
  | 'workspace-unknown'
  | 'path-invalid'
  | 'not-found'
  | 'not-regular'
  | 'symlink'
  | 'git-dir'
  | 'too-large'
  | 'not-text'
  | 'mixed-eol'
  | 'unmappable'
  | 'stale-version'
  | 'changed'
  | 'io'

/** One typed Remote failure; `details` varies by {@link WorkspaceFileWriteErrorCode}. */
export interface WorkspaceFileWriteFailure {
  readonly code: WorkspaceFileWriteErrorCode
  readonly message: string
  readonly details: {
    /** Present version of the file on disk, for `stale-version` and `changed`. */
    readonly currentVersion?: string
    /** Viable encoding names the codec probed, for `not-text`. */
    readonly candidates?: readonly string[]
  }
}

/** Which decode candidate settled an editable open (`explicit` cannot occur: open never requests an encoding). */
export type WorkspaceFileEncodingSource =
  | 'explicit' | 'sticky' | 'bom' | 'utf8' | 'host' | 'locale' | 'fallback'

/** Result of one editable open: complete LF-normalized content plus its guard facts. */
export interface WorkspaceFileOpenResult {
  /** Complete file content, CRLF collapsed to LF; BOM bytes stripped. */
  readonly content: string
  /** `FsVersion` freshness token the next save must present. */
  readonly version: string
  /** Full byte size of the file on disk. */
  readonly bytes: number
  /** Canonical encoding name the file decoded with (iconv-lite spelling). */
  readonly encoding: string
  /** Which decode candidate produced `encoding`. */
  readonly encodingSource: WorkspaceFileEncodingSource
  /** Whether the file's bytes began with the encoding's byte order mark. */
  readonly bom: boolean
  /** Dominant line-ending style of the decoded text; a save restores it. */
  readonly eol: 'LF' | 'CRLF'
}

/** Result of one version probe over an editable path. */
export type WorkspaceFileStatResult =
  | { readonly version: string }
  | { readonly absent: true }

/** One version-checked save request. */
export interface WorkspaceFileSaveRequest {
  /** Complete edited content, LF line endings. */
  readonly content: string
  /** `FsVersion` the editor opened at; a mismatch refuses with `stale-version`. */
  readonly baseVersion: string
  /**
   * Caller-minted idempotency identity: a retried request whose `saveId` already
   * committed resolves with the recorded outcome instead of writing again.
   * Pattern `^[\w-]{1,128}$`.
   */
  readonly saveId: string
}

/** Result of one committed save. */
export interface WorkspaceFileSaveResult {
  /** `FsVersion` the write produced; the editor's new baseline. */
  readonly version: string
}
