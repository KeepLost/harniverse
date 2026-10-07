/**
 * Hard path rules for the workspace file-editing surface. Every rule the read
 * inspector enforces applies here with write-side consequences: the registered
 * Workspace root must still be its canonical directory, the request path must
 * be relative and stay inside it, no path segment may be `.git`, and the
 * resolved target must be a regular file whose canonical form equals its
 * lexical spelling (a symbolic link anywhere on the final spelling refuses).
 * The rules are deliberately not configurable.
 * @module @deepseek-ai/dsh-workspace-file-write/containment
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFileWriteErrorCode } from './types.ts'

/**
 * Fail a path gate with the shared error vocabulary of this Remote.
 * @param code - the Remote error code for the refused rule.
 * @param message - the human-readable refusal reason.
 * @param details - structured context attached to the error.
 * @returns the error to throw.
 */
export function pathError(
  code: WorkspaceFileWriteErrorCode,
  message: string,
  details: object = {},
): RemoteError<WorkspaceFileWriteErrorCode> {
  return new RemoteError<WorkspaceFileWriteErrorCode>(code, message, details)
}

/**
 * Whether a workspace-relative path contains a `.git` path segment.
 * @param path - the workspace-relative request path; `/` and `\` both separate segments.
 * @returns `true` when any segment is `.git`.
 */
export function hasGitSegment(path: string): boolean {
  return path.split(/[/\\]/).includes('.git')
}

/**
 * Compare two absolute paths under the host platform's case rules.
 * @param left - one absolute path.
 * @param right - the other absolute path.
 * @returns whether both name the same filesystem path.
 */
export function sameFilesystemPath(left: string, right: string): boolean {
  /* v8 ignore next -- one platform arm runs per lane; native Windows
     coverage owns the case-insensitive comparison. */
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** A path that passed every gate: its canonical root and lexical target. */
export interface ContainedPath {
  /** Canonical root directory (already realpath-verified against the registration). */
  readonly root: string
  /** The workspace-relative request path, validated. */
  readonly relative: string
  /** Absolute lexical target under the canonical root. */
  readonly target: string
}

/**
 * Validate one workspace-relative request path lexically against a canonical
 * root: refuse NUL bytes, absolute inputs, escapes, and `.git` segments.
 * @param root - canonical Workspace root directory.
 * @param path - workspace-relative request path.
 * @returns the validated lexical target.
 */
export function lexicalContainedPath(root: string, path: string): string {
  if (path.includes('\0') || isAbsolute(path)) {
    throw pathError('path-invalid', `workspace path ${JSON.stringify(path)} must be relative`)
  }
  if (hasGitSegment(path)) {
    throw pathError('git-dir', `workspace path ${JSON.stringify(path)} crosses the repository metadata directory`)
  }
  const target = resolve(root, path)
  const fromRoot = relative(root, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw pathError('path-invalid', `workspace path ${JSON.stringify(path)} escapes the workspace`)
  }
  return target
}

/**
 * Verify the registered root is still its canonical directory, then validate
 * the request path lexically against that canonical root.
 * @param registeredPath - the Workspace record's registered canonical path.
 * @param path - workspace-relative request path.
 * @returns the canonical root and validated lexical target.
 */
export async function containedRoot(registeredPath: string, path: string): Promise<ContainedPath> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(registeredPath)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw pathError('not-found', 'the registered workspace directory no longer resolves')
    }
    throw pathError('io', `the registered workspace directory cannot be resolved: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!sameFilesystemPath(canonicalRoot, resolve(registeredPath))) {
    throw pathError('path-invalid', 'the registered workspace path no longer resolves to its canonical directory')
  }
  return { root: canonicalRoot, relative: path, target: lexicalContainedPath(canonicalRoot, path) }
}

/**
 * Canonicalize a lexically contained target, refusing symbolic links on the
 * final spelling.
 * @param contained - the lexically validated target.
 * @returns the canonical target, equal to the lexical spelling.
 */
export async function canonicalTarget(contained: ContainedPath): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(contained.target)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw pathError('not-found', `workspace entry ${JSON.stringify(contained.relative)} was not found`)
    }
    throw pathError('io', `workspace entry ${JSON.stringify(contained.relative)} cannot be resolved`)
  }
  if (!sameFilesystemPath(canonical, contained.target)) {
    throw pathError('symlink', `workspace path ${JSON.stringify(contained.relative)} contains a symbolic link`)
  }
  return canonical
}

/**
 * Canonicalize like {@link canonicalTarget} but report a missing entry as
 * `undefined` instead of refusing: the version probe's absent arm.
 * @param contained - the lexically validated target.
 * @returns the canonical target, or undefined when the entry is gone.
 */
export async function canonicalTargetTolerant(contained: ContainedPath): Promise<string | undefined> {
  try {
    return await canonicalTarget(contained)
  } catch (error: unknown) {
    if (error instanceof RemoteError && error.code === 'not-found') return undefined
    throw error
  }
}
