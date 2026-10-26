/** Credential recognition, masking forms, and forward-query behavior of the scanner. */

import { describe, expect, it } from 'vitest'
import { CredentialScanner } from '../src/client/credential-scanner.ts'
import { formatTables } from '../src/client/format-tables.ts'
import { createSecretRule } from '../src/client/secret-rule.tsx'

// Samples are assembled at run time so the repository holds no literal in a credential format.
const hex = (length: number): string => '0123456789abcdef'.repeat(8).slice(0, length)
const mixed = (length: number): string => 'a1B2c3D4e5F6g7H8i9J0'.repeat(8).slice(0, length)
const stars = (length: number): string => '*'.repeat(length)
const join = (...parts: string[]): string => parts.join('')

const scanner = (): CredentialScanner => new CredentialScanner(formatTables())

/** Every recognized range, in order. */
const ranges = (text: string): { start: number; end: number; masked: string }[] => {
  const subject = scanner()
  const found: { start: number; end: number; masked: string }[] = []
  let from = 0
  while (from <= text.length) {
    const match = subject.match(text, from)
    if (match === undefined) break
    found.push(match)
    from = Math.max(match.end, match.start + 1)
  }
  return found
}

const found = (text: string): string[] => ranges(text).map(range => text.slice(range.start, range.end))
const masks = (text: string): string[] => ranges(text).map(range => range.masked)

describe('credential recognition', () => {
  it.each([
    ['a model-service key', join('sk', '-', hex(32))],
    ['a project-scoped model-service key', join('sk', '-proj-', mixed(48))],
    ['a Google API key', join('AI', 'za', mixed(35))],
    ['a GitHub classic token', join('gh', 'p_', mixed(36))],
    ['a GitHub fine-grained token', join('github', '_pat_', mixed(22), '_', mixed(59))],
    ['a GitLab token', join('gl', 'pat-', mixed(20))],
    ['an npm token', join('np', 'm_', mixed(36))],
    ['a Hugging Face token', join('h', 'f_', mixed(34))],
    ['an AWS access key ID', join('AK', 'IA', 'ABCDEFGHIJ234567')],
    ['a temporary AWS access key ID', join('AS', 'IA', 'ABCDEFGHIJ234567')],
    ['an Alibaba Cloud AccessKey ID', join('LT', 'AI', mixed(20))],
    ['a Tencent Cloud SecretId', join('AK', 'ID', mixed(32))],
    ['a Slack token', join('xo', 'xb-', '1234567890-', mixed(24))],
    ['a Stripe secret key', join('sk', '_live_', mixed(24))],
    ['a Stripe restricted key', join('rk', '_test_', mixed(24))],
    ['a Stripe webhook secret', join('wh', 'sec_', mixed(32))],
    ['a JSON Web Token', join('eyJ', mixed(24), '.eyJ', mixed(36), '.', mixed(43))],
    ['a private key block', [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA1examplebodyline1',
      'MIIEpAIBAAKCAQEA1examplebodyline2',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')],
  ])('recognizes %s', (_name, sample) => {
    const text = `leading text ${sample} trailing text`
    expect(found(text)).toEqual([sample])
  })

  it('recognizes the password of an address that carries credentials', () => {
    const password = mixed(16)
    expect(found(`leading https://${mixed(12)}:${password}@host.test/path trailing`)).toEqual([password])
  })

  it('recognizes every occurrence across the text', () => {
    const first = join('gh', 'p_', mixed(36))
    const second = join('sk', '-', hex(32))
    expect(found(`a ${first} b ${second} c`)).toEqual([first, second])
  })

  it.each([
    ['a short sk- run', join('sk', '-', hex(12))],
    ['a digit-free sk- run', join('sk', '-', 'a'.repeat(24))],
    ['a GitHub token inside a word', `prefix${join('gh', 'p_', mixed(36))}`],
    ['an ordinary assignment', 'password=hunter2'],
    ['the word sk- alone', 'sk-'],
    ['an address without a password', 'https://user@host.test/'],
  ])('leaves %s plain', (_name, sample) => {
    expect(found(`leading ${sample} trailing`)).toEqual([])
  })
})

describe('masking forms', () => {
  it('keeps the first eight characters of a prefixed key and masks the rest', () => {
    const key = join('sk', '-', hex(32))
    expect(masks(`text ${key} tail`)).toEqual([`${key.slice(0, 8)}${stars(key.length - 8)}`])
  })

  it('keeps the BEGIN and END lines of a key block and masks the body', () => {
    const block = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n')
    const [masked] = masks(block)
    expect(masked).toContain('-----BEGIN OPENSSH PRIVATE KEY-----')
    expect(masked).toContain('-----END OPENSSH PRIVATE KEY-----')
    expect(masked).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB')
  })

  it('masks an address password but not the address around it', () => {
    const password = mixed(16)
    const [masked] = masks(`https://user:${password}@host.test/path`)
    expect(masked).toBe(stars(password.length))
  })
})

describe('forward queries and the rule', () => {
  it('answers repeated nextMatch queries with advancing offsets over one text', () => {
    const first = join('gh', 'p_', mixed(36))
    const second = join('gh', 'p_', mixed(36))
    const text = `${first} and ${second}`
    const rule = createSecretRule(() => 'label')
    const seen: string[] = []
    let from = 0
    while (from <= text.length) {
      const match = rule.nextMatch(text, from)
      if (match === undefined) break
      seen.push(text.slice(match.start, match.end))
      from = Math.max(match.end, match.start + 1)
    }
    expect(seen).toEqual([first, second])
  })

  it('carries the rule identity and a render component', () => {
    const rule = createSecretRule(() => 'label')
    expect(rule.id).toBe('secret')
    expect(rule.Render).toBeTypeOf('function')
  })
})
