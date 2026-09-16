/** Request context panel: the model-visible composition of the selected
 * request, one row per segment, each row navigating to its trajectory record. */

import css from './RequestContextPanel.module.css'

export interface RequestContextPanelProps {
  /** Segments in model-visible order, derived from the conversation nodes. */
  segments: readonly {
    kind: 'message' | 'summary'
    seq: number
    role: string
    shadowedItemCount?: number
    shadowedTokenCount?: number
  }[]
  /** Navigate the trajectory to the record owning this source seq. */
  onLocate: (seq: number) => void
}

function shadowedLabel(count: number | undefined, tokens: number | undefined): string {
  if (count === undefined) return 'replaced prior items'
  const items = `replaced ${count} item${count === 1 ? '' : 's'}`
  return tokens === undefined ? items : `${items} (~${tokens} tokens)`
}

/** Render the context composition list for one request. */
export function RequestContextPanel({ segments, onLocate }: RequestContextPanelProps) {
  if (segments.length === 0) {
    return <p className={css.empty}>No context items before this request.</p>
  }
  return (
    <ol className={css.list} data-testid="request-context-panel">
      {segments.map(segment => (
        <li key={`${segment.kind}\u0000${segment.seq}`} className={css.row}>
          <button
            type="button"
            className={segment.kind === 'summary'
              ? `${css.locate} ${css.locateSummary}`
              : css.locate}
            onClick={() => { onLocate(segment.seq) }}
            title={`Locate #${segment.seq} in the trajectory`}
          >
            <span className={css.seq}>#{segment.seq}</span>
            <span className={css.role}>{segment.role}</span>
            {segment.kind === 'summary' && (
              <span className={css.shadowed}>
                {shadowedLabel(segment.shadowedItemCount, segment.shadowedTokenCount)}
              </span>
            )}
          </button>
        </li>
      ))}
    </ol>
  )
}
