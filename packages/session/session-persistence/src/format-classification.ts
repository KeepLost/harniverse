/**
 * Session format-version classification: the seam's four-value face over a
 * stored header's `version` field, for consumers that must characterize a log
 * (listing, diagnostics, import flows) without the load path's
 * exception-shaped refusals.
 *
 * @module @deepseek-ai/dsh-session-persistence
 */

import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

/**
 * What a stored session's format version says about this build's ability to
 * interpret the log.
 *
 * - `current` — the version this build stamps and reads natively.
 * - `migration-required` — an older generation this build knows how to name
 *   but (while `SESSION_FORMAT_VERSION` is `0`, the oldest generation) has no
 *   shipped upgrade path; surfaced through the injected-current face so the
 *   first future bump has a classification to migrate from.
 * - `unsupported` — a version newer than this build; the load path refuses it
 *   as {@link SessionFormatUnsupportedError} with the "upgrade the harness"
 *   refusal.
 * - `malformed` — not a format version at all (non-integer, negative, or
 *   non-number); the header itself is suspect.
 */
export type SessionFormatClassification =
  | 'current'
  | 'migration-required'
  | 'unsupported'
  | 'malformed'

/**
 * Classify one stored session format version against the version this build
 * reads. Pure and total: every input lands in exactly one class, so callers
 * can branch without exception handling.
 * @param version - the `version` field read from a stored session header, unvalidated.
 * @param currentVersion - the reading build's supported version; defaults to
 *   {@link SESSION_FORMAT_VERSION} and is injectable so older-generation
 *   semantics stay pinnable while `0` is the oldest generation.
 * @returns the version's classification; never `undefined`.
 */
export function classifySessionFormatVersion(
  version: unknown,
  currentVersion: number = SESSION_FORMAT_VERSION,
): SessionFormatClassification {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return 'malformed'
  if (version === currentVersion) return 'current'
  return version > currentVersion ? 'unsupported' : 'migration-required'
}
