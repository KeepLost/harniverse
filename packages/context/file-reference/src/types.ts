/** Public path-only file-reference records. */

/** One completion candidate inside the addressed Agent workspace. */
export interface FileReferenceCandidate {
  /** Relative prompt path, never file contents or an absolute host path. */
  path: string
  /** Directories keep completion open for continuation. */
  kind: 'file' | 'directory'
}
