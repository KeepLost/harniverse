// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isHostLocalHostname, isHostLocalUrl } from '../src/client/host-local-links.ts'

describe('isHostLocalHostname', () => {
  it('claims the page origin itself, loopback, and .localhost subdomains', () => {
    expect(isHostLocalHostname('harniverse.test', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('localhost', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('app.localhost', 'harniverse.test')).toBe(true)
  })

  it('claims the whole loopback and unspecified IPv4 blocks', () => {
    expect(isHostLocalHostname('127.0.0.1', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('127.8.9.10', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('0.0.0.0', 'harniverse.test')).toBe(true)
  })

  it('claims the intranet ranges and refuses public IPv4', () => {
    expect(isHostLocalHostname('10.1.2.3', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('172.16.0.9', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('172.31.255.255', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('192.168.1.5', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('169.254.7.7', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('172.32.0.1', 'harniverse.test')).toBe(false)
    expect(isHostLocalHostname('192.169.0.1', 'harniverse.test')).toBe(false)
    expect(isHostLocalHostname('8.8.8.8', 'harniverse.test')).toBe(false)
  })

  it('claims IPv6 loopback and local ranges, refuses public v6 and names', () => {
    expect(isHostLocalHostname('[::1]', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('[fc00::1]', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('[fdab::1]', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('[fe80::1]', 'harniverse.test')).toBe(true)
    expect(isHostLocalHostname('[2001:db8::1]', 'harniverse.test')).toBe(false)
    expect(isHostLocalHostname('example.com', 'harniverse.test')).toBe(false)
  })
})

describe('isHostLocalUrl', () => {
  it('routes by the parsed hostname against the page origin', () => {
    expect(isHostLocalUrl('http://127.0.0.1:5173/preview')).toBe(true)
    expect(isHostLocalUrl('https://example.com/press')).toBe(false)
  })

  it('declines a value that does not parse as an absolute URL', () => {
    expect(isHostLocalUrl('not-a-url')).toBe(false)
  })
})
