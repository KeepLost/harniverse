/**
 * Hard path rules for the workspace file-editing surface. Every rule the read
 * inspector enforces applies here with write-side consequences: the registered
 * Workspace root must still be its canonical directory, the request path must
 * be relative and stay inside it, no path segment may be `.git`, and the
 * resolved target must be a regular file whose canonical form equals its
 * lexical spelling (a symbolic link anywhere on the final spelling refuses).
 * Exclusive creates walk the path one segment at a time under the same
 * canonical-identity rule and re-verify the published entry before the ack.
 * The rules are deliberately not configurable.
 * @module @deepseek-ai/dsh-workspace-file-write/containment
 */

import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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

/** Read flags that open an existing regular file without following a final symbolic link. */
const READ_NOFOLLOW_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW

/** One walked entry's message context: the workspace-relative request path. */
type DisplayPath = string

/** Render a refusal message suffix from an unknown failure. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Probe one entry without following a final symbolic link; undefined when absent. */
async function entryInfo(target: string, display: DisplayPath): Promise<Stats | undefined> {
  try {
    return await lstat(target)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw pathError('io', `workspace entry ${JSON.stringify(display)} cannot be inspected: ${failureText(error)}`)
  }
}

/** Refuse a walked segment that is a symbolic link or not a directory. */
function requireDirectory(info: Stats, display: DisplayPath): void {
  if (info.isSymbolicLink()) {
    throw pathError('symlink', `workspace path ${JSON.stringify(display)} contains a symbolic link`)
  }
  if (!info.isDirectory()) {
    throw pathError('path-invalid', `workspace path ${JSON.stringify(display)} descends through a non-directory entry`)
  }
}

/** Require one just-inspected entry's canonical form to equal its lexical spelling. */
async function requireCanonical(target: string, display: DisplayPath): Promise<void> {
  let canonical: string
  try {
    canonical = await realpath(target)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw pathError('changed', `workspace entry ${JSON.stringify(display)} changed while creating`)
    }
    throw pathError('io', `workspace entry ${JSON.stringify(display)} cannot be resolved: ${failureText(error)}`)
  }
  if (!sameFilesystemPath(canonical, target)) {
    throw pathError('symlink', `workspace path ${JSON.stringify(display)} contains a symbolic link`)
  }
}

/**
 * Split one validated contained path into its walkable segments, refusing a
 * path that names the Workspace root itself (a create needs a leaf).
 * @param contained - the lexically validated target.
 * @returns the normalized path's segments, outermost first.
 */
export function containedSegments(contained: ContainedPath): string[] {
  const fromRoot = relative(contained.root, contained.target)
  if (fromRoot === '') {
    throw pathError('path-invalid', `workspace path ${JSON.stringify(contained.relative)} names the workspace root`)
  }
  return fromRoot.split(sep)
}

/**
 * Ensure one intermediate directory exists with canonical identity: create it
 * when absent, then require its resolved form to equal its lexical spelling
 * (a swapped or pre-existing symbolic link refuses, before or after creation).
 * @param parent - the verified canonical parent directory.
 * @param segment - the single path segment to ensure below `parent`.
 * @param display - the workspace-relative request path for refusal messages.
 * @returns the verified lexical directory path, equal to `join(parent, segment)`.
 */
export async function ensureIntermediateDirectory(
  parent: string,
  segment: string,
  display: DisplayPath,
): Promise<string> {
  const target = join(parent, segment)
  const present = await entryInfo(target, display)
  if (present === undefined) {
    try {
      await mkdir(target)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw pathError('io', `workspace directory ${JSON.stringify(display)} cannot be created: ${failureText(error)}`)
      }
      const raced = await entryInfo(target, display)
      if (raced === undefined) {
        throw pathError('changed', `workspace entry ${JSON.stringify(display)} changed while creating`)
      }
      requireDirectory(raced, display)
    }
  } else {
    requireDirectory(present, display)
  }
  await requireCanonical(target, display)
  return target
}

/**
 * Refuse a path whose final entry already exists, whatever its kind: an
 * exclusive create never follows, truncates, or overwrites.
 * @param target - the validated lexical final-entry path.
 * @param display - the workspace-relative request path for refusal messages.
 */
export async function requireAbsentEntry(target: string, display: DisplayPath): Promise<void> {
  const present = await entryInfo(target, display)
  if (present !== undefined) {
    throw pathError('exists', `workspace entry ${JSON.stringify(display)} already exists`)
  }
}

/**
 * Create the final directory exclusively (strict, not mkdir -p idempotent): a
 * racing or pre-existing occupant refuses with `exists`.
 * @param target - the validated lexical directory path.
 * @param display - the workspace-relative request path for refusal messages.
 */
export async function createExclusiveDirectory(target: string, display: DisplayPath): Promise<void> {
  try {
    await mkdir(target)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw pathError('exists', `workspace entry ${JSON.stringify(display)} already exists`)
    }
    throw pathError('io', `workspace directory ${JSON.stringify(display)} cannot be created: ${failureText(error)}`)
  }
}

/** Map a no-follow descriptor open failure onto the typed refusal vocabulary. */
function noFollowOpenRefusal(error: unknown, display: DisplayPath): RemoteError<WorkspaceFileWriteErrorCode> {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ELOOP') {
    return pathError('symlink', `workspace path ${JSON.stringify(display)} contains a symbolic link`)
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return pathError('changed', `workspace entry ${JSON.stringify(display)} changed while creating`)
  }
  return pathError('io', `workspace entry ${JSON.stringify(display)} cannot be opened: ${failureText(error)}`)
}

/* v8 ignore next 4 -- reached only when the close of a freshly read
   read-only descriptor itself fails, a double fault with no observable
   outcome to test: the verification verdict is already pinned above. */
function swallowCloseFailure(): void {}

/**
 * Re-verify one just-created entry: a no-follow descriptor (`O_NOFOLLOW` for
 * a file, a no-follow entry probe for a directory) of the required kind, the
 * canonical spelling of the path, and the dev/ino identity cross-check
 * against the followed canonical path.
 * @param target - the validated lexical path of the created entry.
 * @param display - the workspace-relative request path for refusal messages.
 * @param kind - the entry kind the create produced.
 */
export async function verifyCreatedEntry(
  target: string,
  display: DisplayPath,
  kind: 'file' | 'directory',
): Promise<void> {
  let info: Stats
  if (kind === 'file') {
    const handle = await open(target, READ_NOFOLLOW_FLAGS).catch((error: unknown) => {
      throw noFollowOpenRefusal(error, display)
    })
    try {
      info = await handle.stat()
    } catch (error: unknown) {
      throw pathError('io', `workspace entry ${JSON.stringify(display)} cannot be inspected: ${failureText(error)}`)
    } finally {
      // The verdict is pinned by the descriptor read above; a close failure
      // on a fresh read-only descriptor adds no fact.
      await handle.close().catch(swallowCloseFailure)
    }
  } else {
    const probe = await entryInfo(target, display)
    if (probe === undefined) {
      throw pathError('changed', `workspace entry ${JSON.stringify(display)} changed while creating`)
    }
    if (probe.isSymbolicLink()) {
      throw pathError('symlink', `workspace path ${JSON.stringify(display)} contains a symbolic link`)
    }
    info = probe
  }
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
    throw pathError('changed', `workspace entry ${JSON.stringify(display)} changed while creating`)
  }
  await requireCanonical(target, display)
  let current: Stats
  try {
    current = await stat(target)
  } catch {
    throw pathError('changed', `workspace entry ${JSON.stringify(display)} changed while creating`)
  }
  if (current.dev !== info.dev || current.ino !== info.ino) {
    throw pathError('changed', `workspace entry ${JSON.stringify(display)} changed while creating`)
  }
}
