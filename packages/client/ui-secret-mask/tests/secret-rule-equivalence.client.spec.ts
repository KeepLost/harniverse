/**
 * The prefix-pruned matcher produces the same ranges as the regular-expression
 * matcher it replaced, on fixed and generated inputs, from every query offset.
 */
import { describe, expect, it } from 'vitest'
import { CredentialScanner } from '../src/client/credential-scanner.ts'
import { formatTables } from '../src/client/format-tables.ts'
import { regexNextMatch } from './regex-oracle.client.ts'

const join = (...parts: string[]): string => parts.join('')
/** Fragments that begin, continue, break, or end each recognized format. */
const FRAGMENTS = [
  join('s', 'k-'), join('s', 'k_live_'), join('r', 'k_test_'), join('AI', 'za'), join('gh', 'p_'), join('gh', 's_'),
  join('github', '_pat_'), join('gl', 'pat-'), join('np', 'm_'), join('h', 'f_'), join('AK', 'IA'), join('AS', 'IA'),
  join('LT', 'AI'), join('AK', 'ID'), join('xo', 'xb-'), join('wh', 'sec_'), join('ey', 'J'), '.', join('.ey', 'J'),
  join('-----BEGIN', ' '), join('-----END', ' '), ' PRIVATE KEY-----', 'PRIVATE KEY-----', 'RSA ',
  '://', 'https', 'postgres', ':', '@', '/', '?', '#', ' ', '\n', '\r\n', '\t', '-', '_', '+',
  'a', 'Z', '0', '7', 'abcdefgh', 'ABCDEFGH', '01234567', 'a1B2c3D4e5F6g7H8i9J0', '用', '：', '🙂',
] as const

/** Deterministic generator so every run checks the same inputs. */
function generator(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

function generated(count: number, seed: number, maxFragments = 60): string[] {
  const random = generator(seed)
  return Array.from({ length: count }, () => {
    const length = 1 + Math.floor(random() * maxFragments)
    return Array.from({ length }, () => {
      const fragment = FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]!
      // Repeat short fragments so length thresholds are crossed on both sides.
      return fragment.length <= 2 ? fragment.repeat(1 + Math.floor(random() * 40)) : fragment
    }).join('')
  })
}

const fill = (unit: string, characters: number): string => unit.repeat(Math.ceil(characters / unit.length)).slice(0, characters)
const FIXED = [
  '',
  join('用 ', 'sk', '-', '0123456789abcdef0123456789abcdef', ' 试试'),
  join('postgres://admin:', 'p4ss-W0rd', '@db.internal:5432/app'),
  join('git clone https://x-access-token:', 'gh', 'p_', fill('a1B2c3', 36), '@github.com/o/r.git'),
  join('redis://:p4ss@cache https://example.com:8080/a@b https://example.com:8443?e=a@b'),
  join('https://', 'sk', '-', '0123456789abcdef0123456789abcdef', ':p4ss-W0rd@api.example.com/v1'),
  [join('-----BEGIN', ' OPENSSH PRIVATE KEY-----'), 'b3BlbnNzaC1rZXk', join('-----END', ' OPENSSH PRIVATE KEY-----')].join('\n'),
  [join('-----BEGIN', ' PRIVATE KEY-----'), 'MIIEvQIBADANBgkq', join('-----END', ' PRIVATE KEY-----')].join('\r\n'),
  join('-----BEGIN', ' PRIVATE KEY-----', 'MIIE', '-----END', ' PRIVATE KEY-----'),
  join('ey', 'J', fill('a1B2', 17), '.', 'ey', 'J', fill('c3D4', 30), '.', fill('e5F6', 43)),
  join('xo', 'xb-1234567890-', 'sk', '-abc_', fill('a1B2', 20)),
  join('AK', 'IA', 'ABCDEFGHIJ234567 ', 'AK', 'IA', 'ABCDEFGHIJ2345678 ', 'LT', 'AI', fill('a1', 20), ' ', 'AK', 'ID', fill('a1', 40)),
  join('x', 's', 'k-----BEGIN', ' RSA PRIVATE KEY-----\nabc\n'),
  join('gl', 'pat-----BEGIN', ' RSA PRIVATE KEY-----\nabc\n-----END', ' RSA PRIVATE KEY-----'),
  join('LT', 'AIza', 'a1B2c3D4e5F6 '),
  fill(join('-', 's', 'k-', 'gh', 'p_', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'), 2_000),
  fill(join('s', 'k-'), 2_000),
  fill(join('ey', 'Jabcdefgh-'), 2_000),
  fill(join('-----BEGIN', ' RSA PRIVATE KEY-----\nabc\n'), 2_000),
  fill('a://u:', 2_000),
  fill(`abcdefghijklmnop://${'u'.repeat(250)}:`, 2_000),
  fill(join('gh', 'p_', fill('a1B2c3', 35), ' '), 2_000),
]

/** Every range one whole-text pass finds, in order, joining overlaps. */
const collect = (next: (text: string, from: number) => { start: number; end: number; masked: string } | undefined, text: string) => {
  const hits: { start: number; end: number; masked: string }[] = []
  let from = 0
  while (from <= text.length) {
    const match = next(text, from)
    if (match === undefined) break
    hits.push(match)
    from = Math.max(match.end, match.start + 1)
  }
  return hits
}

describe('prefix-pruned credential matching', () => {
  it.each([['fixed', FIXED], ['generated', generated(5_000, 5824)]] as const)('matches the regular-expression ranges on %s inputs', (_name, texts) => {
    const subject = new CredentialScanner(formatTables())
    for (const text of texts) {
      expect(collect((t, f) => subject.match(t, f), text), JSON.stringify(text))
        .toEqual(collect((t, f) => regexNextMatch(t, f), text))
    }
  })

  it('matches the regular-expression candidate from every query offset', () => {
    for (const text of [...FIXED.filter(text => text.length <= 600), ...generated(400, 77, 25)]) {
      for (let from = 0; from <= text.length; from++) {
        const subject = new CredentialScanner(formatTables())
        expect(subject.match(text, from), `${JSON.stringify(text)} from ${String(from)}`)
          .toEqual(regexNextMatch(text, from))
      }
    }
  })
})
