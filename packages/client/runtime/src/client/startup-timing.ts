/** Runtime-side startup marks; diagnostics must never alter data loading. */
export function markClientStartup(name: string): void {
  if (typeof performance !== 'undefined') performance.mark(`dsh:${name}`)
}

export function measureClientStartup(name: string, start: string, end: string): void {
  if (typeof performance === 'undefined') return
  try {
    performance.measure(`dsh:${name}`, `dsh:${start}`, `dsh:${end}`)
  } catch {
    // Timing is best-effort and must not affect the client runtime.
  }
}
