import { describe, expect, it } from 'vitest'
import { embeddedOrigin } from '../src/origin.ts'

describe('embedded origin', () => {
  it('reaches a plain HTTP server through the loopback literal on the assigned port', () => {
    expect(embeddedOrigin({ port: 41234, protocol: 'http:' })).toBe('http://127.0.0.1:41234')
  })

  it('reaches an HTTPS server by the name a certificate can carry', () => {
    expect(embeddedOrigin({ port: 443, protocol: 'https:' })).toBe('https://localhost:443')
  })
})
