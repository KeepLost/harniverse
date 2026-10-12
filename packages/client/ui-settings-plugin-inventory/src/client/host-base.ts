/** Browser-side Host base resolution for direct download URLs. */

/**
 * Resolve the browser's Host base with the connection carrier's null-origin
 * fallback.
 * @param origin - the current page origin, when a browser page provides one.
 * @returns the origin for same-origin Host URLs; `http://dsh.internal` inside
 * the null-origin sandbox the connection carrier documents.
 */
export function hostBase(origin: string | undefined): string {
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}
