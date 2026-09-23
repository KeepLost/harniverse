/**
 * Host-side navigation policy for the browser panel. Every navigation the
 * panel asks for is reviewed here, on the host, because the page now loads
 * from the host's own network position: the operator — not the client — decides
 * which destinations the harness will reach on a user's behalf.
 *
 * Scope boundary worth stating plainly: this reviews the *navigation* the panel
 * requests. Chromium resolves DNS and fetches subresources itself, so a
 * hostname that resolves to a private address is not caught by the literal
 * checks below, and a page's own subresources are not reviewed at all. The
 * model-facing fetch seam (`@deepseek-ai/dsh-web-fetch-http`) pins its lookups
 * for exactly that reason; a real browser cannot be pinned the same way, so the
 * private-range rule here is a deliberate default-deny for the addresses an
 * operator has to opt into, not an airtight egress filter.
 */

/** Operator-owned navigation rules resolved from the controller config. */
export interface BrowserNavigationPolicy {
  /** Permitted hosts; empty means every host the other rules allow. */
  readonly allowedHosts: readonly string[]
  /** Whether loopback, link-local, and private-range destinations are permitted. */
  readonly allowPrivateAddresses: boolean
}

/** Outcome of one navigation review. */
export type BrowserNavigationReview =
  | { readonly allowed: true; readonly url: string }
  | { readonly allowed: false; readonly reason: string }

/** Schemes the panel may navigate to; everything else is refused. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** Private IPv4 ranges rejected unless the operator opts in. */
const PRIVATE_IPV4 = [
  /^0\./u,
  /^10\./u,
  /^127\./u,
  /^169\.254\./u,
  /^172\.(?:1[6-9]|2\d|3[01])\./u,
  /^192\.168\./u,
] as const

/**
 * Whether a host literal or name names the host's own network neighbourhood.
 * Names are matched only for the suffixes that are private by definition; a
 * public name that resolves to a private address cannot be detected here.
 * @param hostname - URL hostname with any IPv6 brackets already stripped.
 * @returns true when the destination is loopback, link-local, or private-range.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '::' || host === '0') return true
  if (host.startsWith('fc') || host.startsWith('fd')) return /^f[cd][0-9a-f]{2}:/u.test(host)
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
    return /^fe[89ab][0-9a-f]:/u.test(host)
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(host)
  const candidate = mapped?.[1] ?? host
  return PRIVATE_IPV4.some(pattern => pattern.test(candidate))
}

/**
 * Whether one hostname satisfies an allowlist entry: an exact match, or a
 * subdomain of it. A leading dot in the entry is accepted and means the same
 * thing as the bare name.
 * @param hostname - navigation hostname.
 * @param entry - allowlist entry.
 * @returns true when the hostname is covered by the entry.
 */
function matchesHost(hostname: string, entry: string): boolean {
  const allowed = entry.trim().toLowerCase().replace(/^\./u, '')
  if (allowed === '') return false
  return hostname === allowed || hostname.endsWith(`.${allowed}`)
}

/**
 * Review one navigation request against the operator policy.
 * @param input - URL text as the panel supplied it; a bare host gains `https://`.
 * @param policy - operator-owned navigation rules.
 * @returns the normalized URL to navigate to, or the refusal reason.
 */
export function reviewNavigation(input: string, policy: BrowserNavigationPolicy): BrowserNavigationReview {
  const trimmed = input.trim()
  if (trimmed === '') return { allowed: false, reason: 'A navigation target is required' }
  const candidate = /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { allowed: false, reason: `${trimmed} is not a valid URL` }
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { allowed: false, reason: `The ${url.protocol} scheme is not available in the browser panel` }
  }
  if (url.username !== '' || url.password !== '') {
    return { allowed: false, reason: 'Credentials embedded in the URL are not accepted' }
  }
  // http and https are special schemes: the URL parser already refused an
  // empty authority, so a parsed host is always present here.
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (!policy.allowPrivateAddresses && isPrivateHost(hostname)) {
    return {
      allowed: false,
      reason: `${hostname} is a loopback or private-network address; the operator has not enabled private destinations`,
    }
  }
  if (policy.allowedHosts.length > 0 && !policy.allowedHosts.some(entry => matchesHost(hostname, entry))) {
    return { allowed: false, reason: `${hostname} is not in the operator's browser host allowlist` }
  }
  return { allowed: true, url: url.toString() }
}
