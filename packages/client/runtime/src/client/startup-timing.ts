/** Runtime-side startup marks; diagnostics must never alter data loading. */
/**
 * Record a named startup mark when the Performance API is available.
 * @param name - the startup phase name.
 */
export function markClientStartup(name: string): void {
  if (typeof performance !== 'undefined') performance.mark(`dsh:${name}`)
}

/**
 * Measure a named startup phase when both marks are available.
 * @param name - the measurement name.
 * @param start - the starting mark name.
 * @param end - the ending mark name.
 */
export function measureClientStartup(name: string, start: string, end: string): void {
  if (typeof performance === 'undefined') return
  try {
    performance.measure(`dsh:${name}`, `dsh:${start}`, `dsh:${end}`)
  } catch {
    // Timing is best-effort and must not affect the client runtime.
  }
}
