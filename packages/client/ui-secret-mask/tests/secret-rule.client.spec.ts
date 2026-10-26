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
    ['ordinary prose', '把密码改一下，token 用量也看看，password=hunter2'],
    ['a hyphenated identifier without digits', 'sk-button-primary-large-rounded'],
    ['a key prefix that is too short', 'sk-12345'],
    ['a key prefix inside a longer word', join('task', '-', hex(32))],
    ['a commit hash', hex(40)],
    ['a UUID', '123e4567-e89b-12d3-a456-426614174000'],
    ['addresses without passwords', 'https://example.com:8080/a@b https://user@example.com/x git@github.com:o/r.git'],
    ['query and fragment addresses', 'https://example.com:8443?email=alice@example.org https://example.com:8443#alice@example.org'],
  ])('leaves %s plain', (_name, sample) => {
    const text = sample.includes('plain-') ? sample : `leading ${sample} trailing`
    expect(found(text)).toEqual([])
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

  it('masks only the password of an address that carries credentials', () => {
    const text = join('postgres://admin:', 'p4ss-W0rd', '@db.internal:5432/app')
    expect(found(text)).toEqual(['p4ss-W0rd'])
    expect(masks(text)).toEqual([stars(9)])
  })

  it('masks a key used as an address user name and the password after it separately', () => {
    const key = join('sk', '-', hex(32))
    const text = `https://${key}:p4ss-W0rd@api.example.com/v1`
    expect(found(text)).toEqual([key, 'p4ss-W0rd'])
    expect(masks(text)).toEqual([key.slice(0, 8) + stars(27), stars(9)])
  })

  it('masks one character per code point, so an emoji or a lone surrogate in a password is one mark', () => {
    expect(masks('postgres://u:p\u{1F642}\ud83dx@db')).toEqual([stars(4)])
  })

  it('ends a key in an address user name before the password, which a later query finds', () => {
    const key = join('sk', '-', hex(32))
    const token = join('gh', 'p_', mixed(36))
    const text = `https://${key}:p4ss-W0rd@api.example.com ${token}`
    expect(found(text)).toEqual([key, 'p4ss-W0rd', token])
  })

  it('masks an address password that has no user name', () => {
    expect(found('redis://:p4ss-W0rd@cache:6379/0')).toEqual(['p4ss-W0rd'])
  })

  it('masks a token used as an address password completely', () => {
    const token = join('gh', 'p_', mixed(36))
    const text = `git clone https://x-access-token:${token}@github.com/o/r.git`
    expect(found(text)).toEqual([token])
    expect(masks(text)).toEqual([stars(token.length)])
  })

  it('joins an overlapping later match to the earliest one and keeps its mask', () => {
    const slack = join('xo', 'xb-', '1234567890-')
    const key = join('sk', '-abc_', mixed(20))
    const text = `${slack}${key} 完`
    expect(found(text)).toEqual([slack + key])
    expect(masks(text)).toEqual([(slack + key).slice(0, 8) + stars(slack.length + key.length - 8)])
  })

  it('masks the body of a private key block and keeps its first and last lines', () => {
    const begin = join('-----BEGIN', ' OPENSSH PRIVATE KEY-----')
    const end = join('-----END', ' OPENSSH PRIVATE KEY-----')
    const block = [begin, 'b3BlbnNzaC1rZXk', 'AAAAB3NzaC1yc2E=', end].join('\n')
    const text = `私钥在这\n${block}\n帮我配一下`
    expect(found(text)).toEqual([block])
    expect(masks(text)).toEqual([[begin, stars(15), stars(16), end].join('\n')])
  })

  it('keeps carriage returns of a private key block with CRLF line endings', () => {
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const text = [begin, 'MIIEvQIBADANBgkq', end].join('\r\n')
    expect(masks(text)).toEqual([[begin, stars(16), end].join('\r\n')])
  })

  it('masks a private key block that is cut off before its last line', () => {
    const begin = join('-----BEGIN', ' RSA PRIVATE KEY-----')
    const text = `${begin}\nMIIEowIBAAKCAQEA`
    expect(found(text)).toEqual([text])
    expect(masks(text)).toEqual([`${begin}\n${stars(16)}`])
  })

  it.each([join('s', 'k-'), join('gl', 'pat-'), join('xo', 'xb-')])('finds a private key block whose first dash ends the key prefix %s', (prefix) => {
    const block = [join('-----BEGIN', ' RSA PRIVATE KEY-----'), 'MIIEowIBAAKCAQEA', join('-----END', ' RSA PRIVATE KEY-----')].join('\n')
    const text = `x${prefix.slice(0, -1)}${block}`
    expect(found(text)).toEqual([block])
  })

  it('masks a key longer than four thousand characters one mark per character', () => {
    const key = join('sk', '-', hex(16), 'a'.repeat(5_000))
    expect(masks(`${key} 完`)).toEqual([key.slice(0, 8) + stars(key.length - 8)])
  })

  it('joins a private key block that starts inside a key and keeps the line breaks of both', () => {
    const key = join('sk', '-', hex(20))
    const block = [join('-----BEGIN', ' RSA PRIVATE KEY-----'), 'MIIE', join('-----END', ' RSA PRIVATE KEY-----')].join('\r\n')
    const text = `${key}${block}`
    expect(found(text)).toEqual([text])
    const tail = text.slice(8).split('\r\n').map(line => stars(line.length)).join('\r\n')
    expect(masks(text)).toEqual([text.slice(0, 8) + tail])
  })

  it('masks a private key body one mark per code point, including lone and cut surrogates', () => {
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const text = [begin, 'a\u{1F642}b\udc00c\ud83dx\ud83d', end].join('\n')
    expect(masks(text)).toEqual([[begin, stars(8), end].join('\n')])
  })

  it('masks private key body lines longer than four thousand characters, before either line break', () => {
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const text = `${begin}\n${'A'.repeat(5_000)}\r\n${'B'.repeat(5_000)}\nC\n${end}`
    expect(masks(text)).toEqual([`${begin}\n${stars(5_000)}\r\n${stars(5_000)}\n${stars(1)}\n${end}`])
  })

  it('masks an address inside a private key block as part of the block', () => {
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const key = join('sk', '-', hex(32))
    const block = [begin, 'https://u:p4ss@host', key, end].join('\n')
    expect(found(`${block}\n用这个`)).toEqual([block])
  })

  it('masks each of many one-line private key blocks whole, with text after the last', () => {
    const block = join('-----BEGIN', ' PRIVATE KEY-----', 'abcd', '-----END', ' PRIVATE KEY-----')
    expect(masks(`${block} ${block} 完`)).toEqual([stars(block.length), stars(block.length)])
  })

  it('masks a private key block written on one line whole', () => {
    const text = join('-----BEGIN', ' PRIVATE KEY-----', 'MIIEvQIBADANBgkq', '-----END', ' PRIVATE KEY-----')
    expect(masks(text)).toEqual([stars(text.length)])
  })
})

describe('forward queries and the rule', () => {
  it('finds format starts through grouped literals only, so scanning cannot backtrack', () => {
    const literals = formatTables().prefixSource.replace(/\\./gu, '').replaceAll('(?:', '').replaceAll(')', '')
    expect(literals.split('|').length).toBeGreaterThan(20)
    expect(literals).not.toMatch(/[*+?{}()[\].^$]/u)
  })

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

  it('memoizes the last queried text, so repeated queries reuse one scan', () => {
    const subject = scanner()
    const first = join('gh', 'p_', mixed(36))
    const second = join('sk', '-', hex(32))
    const text = `${first} 和 ${second}`
    expect(subject.match(text, 0)?.end).toBe(first.length)
    expect(subject.match(text, first.length + 3)?.start).toBe(first.length + 3)
    // The same text again hits the memo rather than re-scanning.
    expect(subject.match(text, 0)?.end).toBe(first.length)
  })

  it('reuses the memoized block bounds when the same block is queried again', () => {
    const subject = scanner()
    const begin = join('-----BEGIN', ' PRIVATE KEY-----')
    const end = join('-----END', ' PRIVATE KEY-----')
    const block = [begin, 'MIIEvQIBADANBgkq', end].join('\n')
    const text = `key\n${block}\ntail`
    const first = subject.match(text, 0)
    expect(first).toBeDefined()
    // A query at an offset inside the same text takes the memoized block bounds.
    expect(subject.match(text, first!.end)).toBeUndefined()
    expect(subject.match(text, 0)).toEqual(first)
  })

  it.each(['postgres://admin:p4ss@db', 'redis://:p4ss@cache'])('finds the same address password in %s from any cursor before it', (text) => {
    const start = text.indexOf('p4ss')
    for (let from = 0; from <= start; from++) {
      // A fresh instance per cursor: no query earlier in the text warms its memo.
      expect(scanner().match(text, from), `from ${String(from)}`).toEqual({ start, end: start + 4, masked: stars(4) })
    }
    expect(scanner().match(text, start + 1)).toBeUndefined()
  })

  it('carries the rule identity and a render component', () => {
    const rule = createSecretRule(() => 'label')
    expect(rule.id).toBe('secret')
    expect(rule.Render).toBeTypeOf('function')
  })

  it('carries the prepared masked form on the match data for the renderer', () => {
    const rule = createSecretRule(() => '揭示')
    const key = join('gh', 'p_', mixed(36))
    const match = rule.nextMatch(`x ${key} y`, 0)
    expect(match).toBeDefined()
    expect(match?.data).toEqual({ masked: key.slice(0, 8) + stars(key.length - 8) })
  })
})
