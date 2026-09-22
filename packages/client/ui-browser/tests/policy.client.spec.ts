/**
 * The navigation policy's exhaustive contract: every acceptance rule
 * (scheme gate, credentials, self-origin with port normalization, optional
 * allowlist) and the URL parser's tricky corners (case, whitespace, IPv6,
 * trailing dots, IDNA) as pure-function checks.
 */
import { describe, expect, it } from 'vitest'
import { reviewNavigation } from '../src/client/policy.ts'

describe('reviewNavigation acceptance shape', () => {
  it('accepts a plain https URL and returns its parsed href', () => {
    expect(reviewNavigation('https://example.com/docs')).toEqual({ ok: true, url: 'https://example.com/docs' })
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(reviewNavigation('  https://example.com/  \n')).toEqual({ ok: true, url: 'https://example.com/' })
  })

  it('accepts an uppercase scheme (the parser lowercases it)', () => {
    expect(reviewNavigation('HTTP://example.com/')).toEqual({ ok: true, url: 'http://example.com/' })
  })

  it('keeps explicit non-default ports in the parsed href', () => {
    expect(reviewNavigation('https://example.com:8443/app')).toEqual({ ok: true, url: 'https://example.com:8443/app' })
  })

  it('strips a redundant default port from the parsed href', () => {
    expect(reviewNavigation('https://example.com:443/')).toEqual({ ok: true, url: 'https://example.com/' })
  })

  it('accepts trailing-dot hostnames and IDNA-encodes unicode ones', () => {
    expect(reviewNavigation('https://example.com./x')).toEqual({ ok: true, url: 'https://example.com./x' })
    expect(reviewNavigation('https://例え.jp/news')).toEqual({ ok: true, url: 'https://xn--r8jz45g.jp/news' })
  })

  it('accepts loopback targets under open browsing', () => {
    expect(reviewNavigation('http://localhost:8080/')).toEqual({ ok: true, url: 'http://localhost:8080/' })
    expect(reviewNavigation('http://127.0.0.1/')).toEqual({ ok: true, url: 'http://127.0.0.1/' })
    expect(reviewNavigation('http://127.200.0.1:9000/')).toEqual({ ok: true, url: 'http://127.200.0.1:9000/' })
    expect(reviewNavigation('http://[::1]:9000/')).toEqual({ ok: true, url: 'http://[::1]:9000/' })
    expect(reviewNavigation('http://app.localhost/')).toEqual({ ok: true, url: 'http://app.localhost/' })
  })
})

describe('reviewNavigation refusals', () => {
  it('refuses blank submissions as empty', () => {
    expect(reviewNavigation('')).toEqual({ ok: false, reason: 'empty' })
    expect(reviewNavigation('   \t ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses unparsable or scheme-less input as malformed', () => {
    expect(reviewNavigation('example.com')).toEqual({ ok: false, reason: 'malformed' })
    expect(reviewNavigation('/relative/path')).toEqual({ ok: false, reason: 'malformed' })
    expect(reviewNavigation('https ://example.com')).toEqual({ ok: false, reason: 'malformed' })
    expect(reviewNavigation('://missing-scheme')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('refuses every non-http(s) scheme', () => {
    expect(reviewNavigation('file:///etc/passwd')).toEqual({ ok: false, reason: 'scheme' })
    expect(reviewNavigation('data:text/html,hello')).toEqual({ ok: false, reason: 'scheme' })
    expect(reviewNavigation('blob:https://example.com/uuid')).toEqual({ ok: false, reason: 'scheme' })
    expect(reviewNavigation('about:blank')).toEqual({ ok: false, reason: 'scheme' })
    expect(reviewNavigation('javascript:alert(1)')).toEqual({ ok: false, reason: 'scheme' })
    expect(reviewNavigation('ftp://example.com/pub')).toEqual({ ok: false, reason: 'scheme' })
  })

  it('checks the scheme before embedded credentials', () => {
    expect(reviewNavigation('ftp://user:pass@example.com/')).toEqual({ ok: false, reason: 'scheme' })
  })

  it('refuses userinfo-embedding URLs of either shape', () => {
    expect(reviewNavigation('https://user:pass@example.com/')).toEqual({ ok: false, reason: 'credentials' })
    expect(reviewNavigation('http://user@example.com/')).toEqual({ ok: false, reason: 'credentials' })
  })
})

describe('reviewNavigation self-origin guard', () => {
  it('refuses the harness origin regardless of path and trailing slash', () => {
    const selfOrigin = 'http://localhost:3000'
    expect(reviewNavigation('http://localhost:3000/', { selfOrigin })).toEqual({ ok: false, reason: 'self-origin' })
    expect(reviewNavigation('http://localhost:3000/app/session', { selfOrigin })).toEqual(
      { ok: false, reason: 'self-origin' },
    )
  })

  it('normalizes empty versus explicit scheme-default ports on both sides', () => {
    expect(reviewNavigation('https://example.com:443/', { selfOrigin: 'https://example.com' })).toEqual(
      { ok: false, reason: 'self-origin' },
    )
    expect(reviewNavigation('https://example.com/', { selfOrigin: 'https://example.com:443' })).toEqual(
      { ok: false, reason: 'self-origin' },
    )
    expect(reviewNavigation('http://localhost/', { selfOrigin: 'http://localhost' })).toEqual(
      { ok: false, reason: 'self-origin' },
    )
  })

  it('matches hosts case-insensitively through one trailing dot', () => {
    expect(reviewNavigation('http://LOCALHOST:3000/', { selfOrigin: 'http://localhost.:3000' })).toEqual(
      { ok: false, reason: 'self-origin' },
    )
  })

  it('still allows a different port, host, or scheme on the same machine', () => {
    const selfOrigin = 'http://localhost:3000'
    expect(reviewNavigation('http://localhost:3001/', { selfOrigin })).toEqual({ ok: true, url: 'http://localhost:3001/' })
    expect(reviewNavigation('http://127.0.0.1:3000/', { selfOrigin })).toEqual(
      { ok: true, url: 'http://127.0.0.1:3000/' },
    )
    expect(reviewNavigation('https://localhost:3000/', { selfOrigin })).toEqual(
      { ok: true, url: 'https://localhost:3000/' },
    )
  })

  it('ignores the guard when the provided origin cannot be parsed', () => {
    expect(reviewNavigation('https://example.com/', { selfOrigin: 'not a url' })).toEqual(
      { ok: true, url: 'https://example.com/' },
    )
  })
})

describe('reviewNavigation allowlist', () => {
  it('allows any host when the allowlist is unset', () => {
    expect(reviewNavigation('https://anywhere.example.net/').ok).toBe(true)
  })

  it('allows exactly the listed hosts after normalization', () => {
    const options = { allowedHosts: ['EXAMPLE.com.'] }
    expect(reviewNavigation('https://example.com/', options)).toEqual({ ok: true, url: 'https://example.com/' })
    expect(reviewNavigation('https://example.com:8443/', options)).toEqual({ ok: true, url: 'https://example.com:8443/' })
  })

  it('refuses unlisted hosts, subdomains, and loopback without an exemption', () => {
    const options = { allowedHosts: ['example.com'] }
    expect(reviewNavigation('https://other.com/', options)).toEqual({ ok: false, reason: 'host-not-allowed' })
    expect(reviewNavigation('https://www.example.com/', options)).toEqual({ ok: false, reason: 'host-not-allowed' })
    expect(reviewNavigation('http://localhost/', options)).toEqual({ ok: false, reason: 'host-not-allowed' })
  })

  it('treats an empty allowlist as a full lockdown', () => {
    expect(reviewNavigation('https://example.com/', { allowedHosts: [] })).toEqual(
      { ok: false, reason: 'host-not-allowed' },
    )
  })
})
