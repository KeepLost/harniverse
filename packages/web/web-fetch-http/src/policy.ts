/**
 * URL validation and content-type classification for the local HTTP(S) fetch
 * provider — the pure, network-free half. The provider's `fetch()` composes
 * these with DNS policy, pinned transport, redirect rejection, byte caps, and
 * decoding.
 *
 * @module @deepseek-ai/dsh-web-fetch-http/policy
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { isIP } from 'node:net'

const NON_PUBLIC_IPV4_RANGES: readonly (readonly [number, number])[] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc01fc400, 24],
  [0xc034c100, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc0af3000, 24],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
]

const NON_PUBLIC_IPV6_RANGES: readonly (readonly [bigint, number])[] = [
  [0n, 96],
  [0xffffn << 32n, 96],
  [1n << 120n, 64],
  [0x2001n << 112n, 23],
  [(0x2001n << 112n) | (0x2n << 96n), 48],
  [(0x2001n << 112n) | (0x10n << 96n), 28],
  [(0x2001n << 112n) | (0x20n << 96n), 28],
  [0x20010db8n << 96n, 32],
  [0x64ff9bn << 96n, 96],
  [0x64ff9b000001n << 80n, 48],
  [0x3fffn << 112n, 20],
  [0xfc00n << 112n, 7],
  [0xfe80n << 112n, 10],
  [0xfec0n << 112n, 10],
  [0xff00n << 112n, 8],
]

/** The body kinds this provider decodes. */
export type FetchableKind = 'html' | 'text'

/**
 * Validate a request URL against the basic transport hygiene the provider
 * enforces before any network access: http(s) only, no embedded credentials,
 * bounded length, and literal IP address scope. Returns the parsed `URL`. Throws
 * {@link WebError} otherwise. Hostname DNS answers are resolved and checked by
 * the provider immediately before its pinned transport request.
 *
 * @param input - the raw URL string from the fetch request.
 * @param maxUrlLength - inclusive upper bound on `input`'s length.
 * @returns the parsed `URL`.
 */
export function validateFetchUrl(input: string, maxUrlLength: number): URL {
  if (input.length > maxUrlLength) {
    throw new WebError(`URL exceeds the maximum length of ${maxUrlLength}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  const hostname = stripIpv6Brackets(url.hostname)
  if (isIP(hostname) !== 0 && !isPublicIp(hostname)) {
    throw new WebError(`non-public IP address "${hostname}" is not allowed`, 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * Return whether an IPv4 or IPv6 address is globally routable for this provider.
 * IPv4-mapped IPv6 addresses are rejected even when their embedded IPv4 address
 * would otherwise be public.
 *
 * @param address - an unbracketed IPv4 or IPv6 address.
 * @returns `true` only for an address outside the provider's non-public ranges.
 */
export function isPublicIp(address: string): boolean {
  const normalized = stripIpv6Brackets(address)
  const family = isIP(normalized)
  if (family === 4) {
    const value = parseIpv4(normalized)
    return value !== undefined && !NON_PUBLIC_IPV4_RANGES.some(range => matchesIpv4Range(value, range))
  }
  if (family === 6) {
    const value = parseIpv6(normalized)
    return value !== undefined && !NON_PUBLIC_IPV6_RANGES.some(range => matchesIpv6Range(value, range))
  }
  return false
}

/**
 * Compare two URLs by scheme, hostname, and port.
 *
 * @param a - one of the two URLs to compare.
 * @param b - the other URL to compare.
 * @returns `true` when `a` and `b` share scheme, hostname, and port.
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * Classify a response `Content-Type` into a decodable body kind, or `undefined`
 * for an unsupported (e.g. binary) type. `text/html` and `application/xhtml+xml`
 * are `html`; other `text/*` plus a few structured text types are `text`.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none (unsupported).
 * @returns the decodable kind, or `undefined` for an unsupported type.
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/**
 * Extract the `charset` parameter from a response `Content-Type`, lower-cased,
 * or `undefined` when absent. The provider feeds this label to `TextDecoder`
 * so a non-UTF-8 response is decoded with its declared encoding rather than
 * silently mangled into replacement characters.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none.
 * @returns the lower-cased charset label, or `undefined` when none is declared.
 */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

/**
 * Build a `TextDecoder` for the declared charset, falling back to UTF-8 when
 * none is declared. Throws {@link WebError} `WEB_UNSUPPORTED_CONTENT_TYPE` when
 * the label is present but not a charset `TextDecoder` recognizes — better to
 * fail loudly than return mojibake.
 *
 * @param charset - the declared charset label (from {@link parseCharset}), or
 *   `undefined` to default to UTF-8.
 * @returns a decoder for the declared (or defaulted) encoding.
 */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (error: unknown) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}

function stripIpv6Brackets(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
}

function parseIpv4(address: string): number | undefined {
  const octets = address.split('.')
  if (octets.length !== 4) return undefined
  let value = 0
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return undefined
    const parsed = Number(octet)
    if (parsed > 255) return undefined
    value = value * 256 + parsed
  }
  return value
}

function parseIpv6(address: string): bigint | undefined {
  const sections = address.toLowerCase().split('::')
  if (sections.length > 2) return undefined
  const left = parseIpv6Sections(sections[0] === '' ? [] : sections[0]?.split(':') ?? [])
  const right = parseIpv6Sections(sections[1] === undefined || sections[1] === '' ? [] : sections[1].split(':'))
  if (left === undefined || right === undefined) return undefined
  const missing = 8 - left.length - right.length
  if (sections.length === 1 ? missing !== 0 : missing < 1) return undefined
  const words = [...left, ...new Array<number>(missing).fill(0), ...right]
  if (words.length !== 8) return undefined
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n)
}

function parseIpv6Sections(sections: string[]): number[] | undefined {
  const words: number[] = []
  for (const [index, section] of sections.entries()) {
    if (section.includes('.')) {
      if (index !== sections.length - 1) return undefined
      const ipv4 = parseIpv4(section)
      if (ipv4 === undefined) return undefined
      words.push(ipv4 >>> 16, ipv4 & 0xffff)
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(section)) return undefined
    words.push(Number.parseInt(section, 16))
  }
  return words
}

function matchesIpv4Range(value: number, [network, prefixLength]: readonly [number, number]): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0
  return (value & mask) === (network & mask)
}

function matchesIpv6Range(value: bigint, [network, prefixLength]: readonly [bigint, number]): boolean {
  const mask = ((1n << BigInt(prefixLength)) - 1n) << BigInt(128 - prefixLength)
  return (value & mask) === network
}
