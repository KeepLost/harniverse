/**
 * Display formatting for counts, durations, speeds, and percentages. Pure and
 * deterministic (no Intl) so specs assert exact strings.
 *
 * @module @deepseek-ai/dsh-client-ui-stats/stats-format
 */

/** Bound for the one-line answer preview shown in the Did column. */
export const STATS_PREVIEW_MAX_CHARS = 120

/**
 * Format one token/char count compactly.
 * @param value - count to format; null renders as an em dash.
 * @returns exact value below ten thousand, one-decimal `k`/`M` above.
 */
export function formatCount(value: number | null): string {
  if (value === null) return '—'
  if (value < 10_000) return String(value)
  if (value < 1_000_000) return `${trimZero((value / 1_000).toFixed(1))}k`
  return `${trimZero((value / 1_000_000).toFixed(1))}M`
}

/**
 * Format one wall duration measured in milliseconds.
 * @param ms - duration; null renders as an em dash.
 * @returns `NNN ms`, `N.NN s`, or `Nm NNs`.
 */
export function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * Format one decode speed in tokens per second.
 * @param tokens - output tokens of the decode span; null renders as an em dash.
 * @param ms - decode wall time.
 * @returns one-decimal speed, or an em dash when either input is missing.
 */
export function formatTps(tokens: number | null, ms: number | null): string {
  if (tokens === null || ms === null || ms <= 0) return '—'
  return `${(tokens / (ms / 1_000)).toFixed(1)} t/s`
}

/**
 * Format one ratio as a percentage.
 * @param part - numerator; null renders as an em dash.
 * @param whole - denominator.
 * @returns rounded percentage, or an em dash when the ratio is undefined.
 */
export function formatPercent(part: number | null, whole: number): string {
  if (part === null || whole <= 0) return '—'
  return `${Math.round((part / whole) * 100)}%`
}

/**
 * Collapse whitespace and bound one preview string.
 * @param text - raw text of any length.
 * @param max - bound; defaults to {@link STATS_PREVIEW_MAX_CHARS}.
 * @returns single-line preview, or null when the text is blank.
 */
export function previewText(text: string, max: number = STATS_PREVIEW_MAX_CHARS): string | null {
  const collapsed = text.replaceAll(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}
