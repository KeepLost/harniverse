/**
 * Service Definition for the spill storage capability seam (`ctx.spillStore`): an abstract service defining WHAT a
 * spill backend does — persist a tool's oversized text and return a model-facing
 * locator and exact byte count — without saying HOW. Implementations
 * subclass {@link SpillStore} and register as the `spillStore` service;
 * `@deepseek-ai/dsh-spill-local` (host filesystem) is the first.
 *
 * The Service Definition is deliberately minimal: bounded save/read operations. It owns NO
 * retention policy (that is `@deepseek-ai/dsh-output-retention`), NO tool-result
 * replacement (that is `@deepseek-ai/dsh-spill-policy`) or search API. The
 * backend supplies only storage facts; Consumers own presentation.
 *
 * @module @deepseek-ai/dsh-spill
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ReadTextSpill, ReadTextSpillPage, SaveTextSpill, SpillRef } from './types.ts'

export { SpillLocator } from './types.ts'
export type {
  ReadTextSpill,
  ReadTextSpillPage,
  SaveTextSpill,
  SpillOwner,
  SpillRef,
  SpillSource,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    spillStore: SpillStore
  }
}

/**
 * Abstract spill storage service. Subclass, implement {@link saveText}, and load
 * the subclass as a plugin — it registers as `ctx.spillStore` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link saveText} persists the FULL `content` verbatim and returns an opaque
 *   locator and exact byte length.
 * - Storage is scoped by the request's {@link SaveTextSpill.owner} session; the
 *   backend chooses a private (not world-readable) location and a collision-free
 *   name derived from — never equal to — the caller's `suggestedName`.
 * - `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend
 *   unavailable); the caller decides how to degrade (the spill policy treats a
 *   rejection as best-effort and keeps the inline result).
 * - Both operations observe the request's caller-owned cancellation signal and
 *   settle promptly after cancellation.
 */
export abstract class SpillStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'spillStore')
  }

  /**
   * Persist `input.content` to a session-scoped spill artifact.
   * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
   * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
   */
  abstract saveText(input: SaveTextSpill): Promise<SpillRef>

  /**
   * Read one bounded page from a locator produced by this backend.
   * @param input - opaque locator, optional backend cursor, and page character limit.
   * @returns bounded text and an opaque continuation cursor when unread text remains.
   */
  abstract readText(input: ReadTextSpill): Promise<ReadTextSpillPage>
}

export default SpillStore
