/** Small, no-op-safe timing bridge for diagnosing browser startup waterfalls. */
export function markStartup(name: string): void {
  if (typeof performance !== 'undefined') performance.mark(`dsh:${name}`)
}

export function measureStartup(name: string, start: string, end: string): void {
  if (typeof performance === 'undefined') return
  try {
    performance.measure(`dsh:${name}`, `dsh:${start}`, `dsh:${end}`)
  } catch {
    // A missing mark should never affect authentication or boot.
  }
}
