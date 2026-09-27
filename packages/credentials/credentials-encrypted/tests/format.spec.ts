import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decrypt, encrypt, snapshot } from '../src/format.ts'

it('accepts exact UTF-8 and complete JSON limits and rejects the next byte', () => {
  expect(snapshot({ KEY: '界'.repeat(21_845) + 'x' }).get('KEY')).toHaveLength(21_846)
  expect(() => snapshot({ KEY: '界'.repeat(21_845) + 'xx' })).toThrow(/snapshot/)
  const values = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`K${index}`, 'x'.repeat(65_536)]))
  values.LAST = ''
  values.LAST = 'x'.repeat(1_048_576 - Buffer.byteLength(JSON.stringify(values)))
  const key = randomBytes(32)
  expect(decrypt(encrypt(snapshot(values), key), key)).toEqual(new Map(Object.entries(values)))
  values.LAST += 'x'
  expect(() => snapshot(values)).toThrow(/snapshot/)
  expect(() => snapshot({ A: '\0'.repeat(65_536), B: '\0'.repeat(65_536), C: '\0'.repeat(65_536) })).toThrow(/snapshot/)
})

it('bounds reference lengths and keeps prototype-shaped identifiers as ordinary credentials', () => {
  const values = Object.fromEntries([['__proto__', 'first'], ['constructor', 'second'], ['A'.repeat(128), 'third']])
  const key = randomBytes(32)
  expect(decrypt(encrypt(snapshot(values), key), key)).toEqual(new Map(Object.entries(values)))
  expect(() => snapshot({ ['A'.repeat(129)]: 'value' })).toThrow(/snapshot/)
})

it('rejects accessors, nonenumerable properties, symbols, and inherited records without invoking getters', () => {
  let invoked = false
  const getter = { get KEY() { invoked = true; return 'secret' } }
  expect(() => snapshot(getter)).toThrow(/snapshot/)
  expect(invoked).toBe(false)
  expect(() => snapshot(Object.defineProperty({}, 'KEY', { value: 'secret' }))).toThrow(/snapshot/)
  expect(() => snapshot({ [Symbol('KEY')]: 'secret' })).toThrow(/snapshot/)
  expect(() => snapshot(Object.create({ KEY: 'secret' }) as unknown)).toThrow(/snapshot/)
})

it.each(['array', 'unknown-field', 'invalid-iv', 'short-tag', 'empty-ciphertext', 'noncanonical-ciphertext'])('rejects the %s envelope', (fault) => {
  const key = randomBytes(32)
  const envelope = JSON.parse(encrypt(snapshot({ KEY: 'value' }), key)) as Record<string, unknown>
  if (fault === 'unknown-field') envelope.extra = 1
  if (fault === 'invalid-iv') envelope.iv = 'not/base64url'
  if (fault === 'short-tag') envelope.tag = 'AA'
  if (fault === 'empty-ciphertext') envelope.ciphertext = ''
  if (fault === 'noncanonical-ciphertext') envelope.ciphertext = 'AB'
  expect(() => decrypt(JSON.stringify(fault === 'array' ? [] : envelope), key)).toThrow()
})
