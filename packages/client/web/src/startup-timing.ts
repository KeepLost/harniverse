/** Small, no-op-safe timing bridge for diagnosing browser startup waterfalls. */
/**
 * Record a named startup mark when the Performance API is available.
 * @param name - the startup phase name.
 */
export function markStartup(name: string): void {
  if (typeof performance !== 'undefined') performance.mark(`dsh:${name}`)
}

/**
 * Measure a named startup phase when both marks are available.
 * @param name - the measurement name.
 * @param start - the starting mark name.
 * @param end - the ending mark name.
 */
export function measureStartup(name: string, start: string, end: string): void {
  if (typeof performance === 'undefined') return
  try {
    performance.measure(`dsh:${name}`, `dsh:${start}`, `dsh:${end}`)
  } catch {
    // A missing mark should never affect authentication or boot.
  }
}
