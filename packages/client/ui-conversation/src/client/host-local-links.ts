/**
 * Host-local link classification for prose-link routing: a URL whose authority
 * is reachable from the harness HOST's network position (loopback, private and
 * link-local ranges, or the harness origin itself) belongs in the host browser
 * panel; everything else belongs to the reader's own browser. Browser-safe and
 * pure — the page hostname rides in as a value so the predicate stays testable
 * without a DOM.
 */

/**
 * Whether one URL hostname names an authority on the reader-facing host side.
 * @param hostname - lowercased WHATWG URL hostname (IPv6 literals keep brackets).
 * @param pageHostname - lowercased hostname of the page the reader sits on.
 * @returns true for loopback, private/link-local ranges, and the page's own host.
 */
export function isHostLocalHostname(hostname: string, pageHostname: string): boolean {
  if (hostname === pageHostname) return true
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === '[::1]' || hostname === '::1') return true
  const quarters = hostname.split('.')
  if (quarters.length === 4 && quarters.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const first = Number(quarters[0])
    const second = Number(quarters[1])
    // 0.0.0.0/8, 10/8, and 127/8 never leave the machine; 172.16/12, 192.168/16,
    // and 169.254/16 are the intranet ranges a remote reader cannot be assumed
    // to reach.
    return first === 0 || first === 10 || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254)
  }
  const v6 = hostname.replace(/^\[|\]$/g, '')
  const head = Number.parseInt(v6.split(':')[0] ?? '', 16)
  // fc00::/7 unique-local and fe80::/10 link-local.
  return !Number.isNaN(head) && ((head >= 0xfc00 && head <= 0xfdff) || (head >= 0xfe80 && head <= 0xfebf))
}

/**
 * Whether an absolute URL is host-local (see {@link isHostLocalHostname}).
 * @param url - the sanitized absolute destination a reader clicked.
 * @returns true when the URL should load from the harness host's network position.
 */
export function isHostLocalUrl(url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  return isHostLocalHostname(parsed.hostname.toLowerCase(), window.location.hostname.toLowerCase())
}
