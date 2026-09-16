/** Context strip: a horizontal band of equal-width blocks under the Trajectory
 * ledger, one block per live model-visible context item (summary landings in a
 * distinct style). Clicking a block navigates the ledger above to its record;
 * the strip itself always mirrors the current context, unaffected by ledger
 * selection. */

import css from './ContextStrip.module.css'

/** One block descriptor: derived live context item or landed compaction. */
export interface ContextStripSegment {
  kind: 'message' | 'summary'
  seq: number
  role: string
  shadowedItemCount?: number
  shadowedTokenCount?: number
}

export interface ContextStripProps {
  /** Live segments in model-visible order (the current context window). */
  segments: readonly ContextStripSegment[]
  /** Navigate the ledger to the record owning this source seq. */
  onLocate: (seq: number) => void
  /** Strip caption; the segment count appends automatically. */
  title: string
  /** Tooltip template: `(role, seq) -> text` for one block. */
  describe: (segment: ContextStripSegment) => string
}

/** Render the horizontal current-context block band. */
export function ContextStrip({ segments, onLocate, title, describe }: ContextStripProps) {
  return (
    <section
      className={css.strip}
      data-testid="context-strip"
      aria-label={`${title} (${segments.length})`}
    >
      <span className={css.title}>{title}</span>
      {segments.length === 0
        ? <span className={css.empty} />
        : (
          <ol className={css.blocks}>
            {segments.map(segment => (
              <li key={`${segment.kind}\u0000${segment.seq}`}>
                <button
                  type="button"
                  className={segment.kind === 'summary'
                    ? `${css.block} ${css.blockSummary}`
                    : css.block}
                  title={describe(segment)}
                  aria-label={describe(segment)}
                  onClick={() => { onLocate(segment.seq) }}
                />
              </li>
            ))}
          </ol>
        )}
    </section>
  )
}
