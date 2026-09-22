/**
 * Navigation policy of the browser carrier panel, enforced at navigation
 * time (the only entry point is the URL bar's submit): a pure function so
 * every rule is exhaustively unit-testable and the panel never hands a
 * rejected URL to the iframe.
 */

/** Why a submitted raw URL was refused. */
export type NavigationRejectReason =
  | 'empty'
  | 'malformed'
  | 'scheme'
  | 'credentials'
  | 'self-origin'
  | 'host-not-allowed'

/** Acceptance: the parsed href the frame navigates to. */
export type NavigationAccept = { ok: true; url: string }

/** Refusal: the user-facing reason. */
export type NavigationRefuse = { ok: false; reason: NavigationRejectReason }

/** Outcome of reviewing one submitted URL. */
export type NavigationReview = NavigationAccept | NavigationRefuse

/** Policy inputs beyond the URL itself. */
export interface NavigationPolicyOptions {
  /** Exact hostnames the panel may navigate to; unset means open browsing. */
  allowedHosts?: readonly string[]
  /** The harness's own origin (window.location.origin), never framable. */
  selfOrigin?: string
}

/**
 * Normalize a hostname for comparison: lowercase and strip one fully
 * qualified trailing dot (`example.com.` is `example.com`). IPv6 literals
 * keep their brackets (`[::1]`), which never collide with dot forms.
 * @param hostname - hostname as reported by the URL parser.
 * @returns the comparable hostname.
 */
function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase()
  return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

/**
 * Resolve a URL's effective port: the parser already strips scheme-default
 * ports, so an empty port maps to 443 (https) or 80 (http); explicit ports
 * (including a redundant `:443` kept by older parsers) compare literally.
 * @param parsed - the parsed URL.
 * @returns the port as a string.
 */
function effectivePort(parsed: URL): string {
  if (parsed.port !== '') return parsed.port
  return parsed.protocol === 'https:' ? '443' : '80'
}

/**
 * Review one submitted URL against the panel's navigation policy: only
 * http/https, no embedded credentials, never the harness's own origin, and —
 * when an allowlist is configured — only listed hosts. The input is trimmed;
 * relative or scheme-less input cannot parse and is refused as malformed.
 * @param raw - the URL exactly as submitted.
 * @param options - the live allowlist and the harness origin, if known.
 * @returns the parsed href on acceptance, or the refusal reason.
 */
export function reviewNavigation(raw: string, options: NavigationPolicyOptions = {}): NavigationReview {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'credentials' }
  if (options.selfOrigin !== undefined) {
    let self: URL | undefined
    try {
      self = new URL(options.selfOrigin)
    } catch {
      self = undefined
    }
    if (
      self !== undefined
      && parsed.protocol === self.protocol
      && normalizeHost(parsed.hostname) === normalizeHost(self.hostname)
      && effectivePort(parsed) === effectivePort(self)
    ) {
      return { ok: false, reason: 'self-origin' }
    }
  }
  if (options.allowedHosts !== undefined) {
    const host = normalizeHost(parsed.hostname)
    const allowed = options.allowedHosts.some(entry => normalizeHost(entry) === host)
    if (!allowed) return { ok: false, reason: 'host-not-allowed' }
  }
  return { ok: true, url: parsed.href }
}
