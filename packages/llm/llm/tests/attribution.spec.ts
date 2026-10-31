import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { APP_IDENTITY, attributionHeaders, clientIdentity, userAgent } from '@deepseek-ai/dsh-llm'
import type { AppIdentity } from '@deepseek-ai/dsh-llm'
import { APP_IDENTITY as IDENTITY_PACKAGE_IDENTITY } from '@deepseek-ai/dsh-identity'

const identityManifest = createRequire(import.meta.url)('@deepseek-ai/dsh-identity/package.json') as { version: string }

/** A white-label identity exercising every override hook. */
const forkIdentity: AppIdentity = {
  product: 'fork-agent',
  version: '9.9.9',
  url: 'https://example.com/fork-agent',
}

describe('APP_IDENTITY', () => {
  it('re-exports the identity package contract unchanged', () => {
    expect(APP_IDENTITY).toBe(IDENTITY_PACKAGE_IDENTITY)
  })

  it('sources the version from the identity package manifest, never a hand-copied constant', () => {
    expect(APP_IDENTITY.version).toBe(identityManifest.version)
  })

  it('carries only static public product facts', () => {
    expect(APP_IDENTITY).toEqual({
      product: 'harniverse',
      version: identityManifest.version,
    })
  })
})

describe('userAgent', () => {
  it('renders product/version without a url comment when the identity has no home', () => {
    expect(userAgent()).toBe(`harniverse/${identityManifest.version}`)
  })

  it('renders a custom identity', () => {
    expect(userAgent(forkIdentity)).toBe('fork-agent/9.9.9 (+https://example.com/fork-agent)')
  })
})

describe('attributionHeaders', () => {
  it('defaults to the provider-neutral baseline: User-Agent and nothing else', () => {
    expect(attributionHeaders()).toEqual({ 'user-agent': userAgent() })
  })

  it('maps a custom identity onto the User-Agent header only', () => {
    expect(attributionHeaders(forkIdentity)).toEqual({
      'user-agent': 'fork-agent/9.9.9 (+https://example.com/fork-agent)',
    })
  })
})

describe('clientIdentity', () => {
  it('projects the product identity into a protocol client introduction', () => {
    expect(clientIdentity()).toEqual({ name: 'harniverse', version: identityManifest.version })
  })
})
