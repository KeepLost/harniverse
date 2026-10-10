/**
 * Display formatting for the skin rows.
 * @module @deepseek-ai/dsh-client-ui-skin/format
 */

/**
 * A byte count in the largest binary unit that keeps it at or above one.
 * @param bytes - non-negative byte count.
 * @returns e.g. `512 B`, `1.5 KiB`, `8 MiB`.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${String(rounded)} ${units[unit] as string}`
}

/**
 * An opacity as the whole percentage a slider shows.
 * @param opacity - 0..1.
 * @returns the rounded percentage, 0..100.
 */
export function toPercent(opacity: number): number {
  return Math.round(opacity * 100)
}
