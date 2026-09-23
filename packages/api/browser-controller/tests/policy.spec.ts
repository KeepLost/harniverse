/** Host-side navigation policy: schemes, credentials, privacy, and the allowlist. */
import { describe, expect, it } from 'vitest'
import type { BrowserNavigationReview } from '../src/policy.ts'
import { isPrivateHost, reviewNavigation } from '../src/policy.ts'

const open = { allowedHosts: [], allowPrivateAddresses: false }

/** Narrow a review to its refusal reason, so assertions read it as a plain string. */
function refusalOf(review: BrowserNavigationReview): string {
  if (review.allowed) throw new Error(`expected a refusal, got ${review.url}`)
  return review.reason
}

describe('reviewNavigation', () => {
  it('adds the https scheme to a bare host and normalizes the URL', () => {
    expect(reviewNavigation('example.com/docs', open)).toEqual({ allowed: true, url: 'https://example.com/docs' })
  })

  it('keeps an explicit http scheme', () => {
    expect(reviewNavigation('http://example.com/', open)).toEqual({ allowed: true, url: 'http://example.com/' })
  })

  it('refuses an empty target', () => {
    expect(reviewNavigation('   ', open)).toEqual({ allowed: false, reason: 'A navigation target is required' })
  })

  it('refuses an unparseable URL', () => {
    expect(refusalOf(reviewNavigation('https://', open))).toContain('not a valid URL')
  })

  it('refuses a host-less URL', () => {
    expect(refusalOf(reviewNavigation('file:///etc/passwd', open))).toContain('scheme is not available')
  })

  it('refuses schemes other than http and https', () => {
    for (const target of ['javascript:alert(1)', 'data:text/html,<b>x', 'about:blank', 'chrome://version']) {
      expect(refusalOf(reviewNavigation(target, open))).toContain('is not available in the browser panel')
    }
  })

  it('refuses credentials embedded in the URL', () => {
    expect(reviewNavigation('https://user:pass@example.com', open)).toEqual({
      allowed: false, reason: 'Credentials embedded in the URL are not accepted',
    })
    expect(reviewNavigation('https://user@example.com', open).allowed).toBe(false)
  })

  it('refuses a URL whose authority parses to no host', () => {
    expect(refusalOf(reviewNavigation('http://:80/x', open))).toContain('is not a valid URL')
  })

  it('refuses private destinations until the operator enables them', () => {
    expect(refusalOf(reviewNavigation('http://localhost:5173/', open))).toContain('has not enabled private destinations')
    expect(reviewNavigation('http://localhost:5173/', { ...open, allowPrivateAddresses: true })).toEqual({
      allowed: true, url: 'http://localhost:5173/',
    })
  })

  it('applies the allowlist to the exact host and its subdomains', () => {
    const policy = { allowedHosts: ['.example.com', 'docs.internal'], allowPrivateAddresses: false }
    expect(reviewNavigation('https://example.com', policy)).toEqual({ allowed: true, url: 'https://example.com/' })
    expect(reviewNavigation('https://api.example.com/v1', policy)).toEqual({ allowed: true, url: 'https://api.example.com/v1' })
    expect(refusalOf(reviewNavigation('https://notexample.com', policy))).toContain("not in the operator's browser host allowlist")
  })

  it('ignores a blank allowlist entry rather than treating it as a wildcard', () => {
    expect(reviewNavigation('https://example.com', { allowedHosts: ['  '], allowPrivateAddresses: false }).allowed).toBe(false)
  })
})

describe('isPrivateHost', () => {
  it('names loopback, link-local, and private ranges', () => {
    for (const host of [
      'localhost', 'app.localhost', 'printer.local', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '0.0.0.0', '0', '::1', '::', 'fd00::1', 'fc00::5', 'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateHost(host), host).toBe(true)
    }
  })

  it('leaves public literals and names alone', () => {
    for (const host of [
      'example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1', '2606:4700::1111', 'fe00::1',
      'fcx0::1', '::ffff:8.8.8.8',
    ]) {
      expect(isPrivateHost(host), host).toBe(false)
    }
  })
})
