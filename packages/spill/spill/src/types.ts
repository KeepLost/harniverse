/**
 * Vocabulary for the spill storage Service Definition. Types only — the abstract service
 * lives in `./index.ts`, implementations in sibling packages
 * (`@deepseek-ai/dsh-spill-local` first).
 *
 * @module @deepseek-ai/dsh-spill/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Opaque model-facing handle for one spilled artifact. A local backend may use a
 * filesystem path; a remote or database backend may use a URI or key. Consumers
 * render but do not parse it.
 */
export type SpillLocator = Branded<'SpillLocator'>

/**
 * Brand a string as a {@link SpillLocator}.
 *
 * @param locator The backend-produced locator string to brand.
 * @returns The branded spill locator.
 */
export function SpillLocator(locator: string): SpillLocator {
  return locator as SpillLocator
}

/**
 * Save-time storage namespace for a spilled artifact. The session id lets a
 * backend group storage under the producing session, but the returned
 * {@link SpillLocator} is the model-facing handle. Forked sessions inherit
 * locators already present in the seeded log; those artifacts are not copied or
 * re-owned, and spills produced after the fork use the child session id.
 */
export interface SpillOwner {
  sessionId: SessionId
}

/**
 * Tool and call that produced one spilled artifact — recorded by the backend for a readable
 * filename and inspection. Not interpreted for access control; purely
 * descriptive.
 */
export interface SpillSource {
  /** The tool whose result was spilled (e.g. `web_fetch`). */
  toolName: string
  /** The model-issued call id the result belongs to. */
  callId: CallId
  /** A short human label for the artifact (e.g. `result`). */
  label: string
}

/** One request to persist text to a spill artifact. */
export interface SaveTextSpill {
  /** Caller-owned cancellation for storage admission and persistence. */
  signal: AbortSignal
  owner: SpillOwner
  source: SpillSource
  /**
   * A caller-suggested base name (e.g. `web_fetch.txt`). The backend sanitizes
   * it to a single safe path segment before use — it is a hint, never a path.
   */
  suggestedName: string
  /** The full text to persist (UTF-8). */
  content: string
}

/** A saved spill artifact: its opaque locator and exact byte length. */
export interface SpillRef {
  locator: SpillLocator
  bytes: number
}

/** One backend-owned request to page a previously saved text artifact. */
export interface ReadTextSpill {
  /** Caller-owned cancellation for locator validation and page retrieval. */
  signal: AbortSignal
  /** Opaque locator returned by {@link SpillRef.locator}; consumers must not parse it. */
  locator: SpillLocator
  /** Opaque continuation cursor returned by the same backend. Omit for the first page. */
  cursor?: string
  /** Maximum Unicode code points to return in this page. */
  maxChars: number
}

/** One bounded page of artifact text plus an opaque cursor when unread text remains. */
export interface ReadTextSpillPage {
  text: string
  nextCursor?: string
}
