import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EncryptedCredentialProvider from '../src/index.ts'
import { decodeKey } from '../src/format.ts'
import { readDocument, writeDocument, UncertainCommitError } from '../src/storage.ts'

vi.mock('../src/format.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/format.ts')>()
  return { ...actual, decodeKey: vi.fn(actual.decodeKey) }
})

vi.mock('../src/storage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage.ts')>()
  return { ...actual, readDocument: vi.fn(actual.readDocument), writeDocument: vi.fn(actual.writeDocument) }
})

const cleanups: Array<() => Promise<unknown>> = []
const REF = credentialRef('MODEL_KEY')

function latch() {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  return { promise, resolve: () => { resolve(undefined) } }
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.mocked(decodeKey).mockClear()
  vi.mocked(readDocument).mockReset()
  vi.mocked(writeDocument).mockReset()
})

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-encrypted-lifecycle-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'credentials.json')
  const ctx = new Context()
  const fiber = ctx.plugin(EncryptedCredentialProvider, { path })
  cleanups.push(() => fiber.dispose())
  await fiber
  const provider = ctx.credentials as EncryptedCredentialProvider
  const key = randomBytes(32).toString('base64url')
  await provider.unlock(key)
  await provider.replace({ MODEL_KEY: 'initial' })
  const events: string[] = []
  ctx.on('credentials/updated', (ref) => { events.push(ref) })
  return { ctx, fiber, provider, key, path, events }
}

it('erases every decoded key buffer on idempotent unlock, rejected unlock, lock, and disposal', async () => {
  const { provider, fiber, key } = await boot()
  const owned = vi.mocked(decodeKey).mock.results[0]!.value as Buffer
  expect(owned.equals(Buffer.from(key, 'base64url'))).toBe(true)
  await provider.unlock(key)
  await expect(provider.unlock(randomBytes(32).toString('base64url'))).rejects.toThrow(/unlock failed/)
  const temporary = vi.mocked(decodeKey).mock.results.slice(1).map(result => result.value as Buffer)
  expect(temporary.every(buffer => buffer.every(byte => byte === 0))).toBe(true)
  await provider.lock()
  expect(owned.every(byte => byte === 0)).toBe(true)
  await provider.unlock(key)
  const reloaded = vi.mocked(decodeKey).mock.results.at(-1)!.value as Buffer
  await fiber.dispose()
  expect(reloaded.every(byte => byte === 0)).toBe(true)
  await expect(provider.resolve(REF)).rejects.toThrow(/disposed/)
  expect(await provider.describe(REF)).toEqual({ configured: false, writable: false })
})

it.each(['lock', 'dispose'] as const)('%s drains an in-flight commit, cancels queued replacement, and suppresses publication', async (action) => {
  const { provider, fiber, path, events } = await boot()
  const gate = latch()
  const entered = latch()
  cleanups.push(async () => { gate.resolve() })
  const actual = await vi.importActual<typeof import('../src/storage.ts')>('../src/storage.ts')
  vi.mocked(writeDocument).mockImplementationOnce(async (...args) => {
    entered.resolve()
    await gate.promise
    await actual.writeDocument(...args)
  })
  const first = provider.replace({ MODEL_KEY: 'in-flight' })
  await entered.promise
  const second = expect(provider.replace({ MODEL_KEY: 'queued' })).rejects.toThrow(/locked|disposed/)
  const closing = action === 'lock' ? provider.lock() : fiber.dispose()
  await vi.waitFor(() => { expect(provider.status()).toEqual({ locked: true }) })
  let finished = false
  void closing.then(() => { finished = true })
  await Promise.resolve()
  expect(finished).toBe(false)
  const owned = vi.mocked(decodeKey).mock.results[0]!.value as Buffer
  expect(owned.every(byte => byte === 0)).toBe(true)
  gate.resolve()
  await first
  await second
  await closing
  expect(events).toEqual([])
  expect(provider.status()).toEqual({ locked: true })
  await expect(provider.resolve(REF)).rejects.toThrow(/locked|disposed/)
  expect(await readFile(path, 'utf8')).not.toContain('in-flight')
})

it('erases a candidate key and rejects unlock when lock interrupts its read', async () => {
  const { provider, key } = await boot()
  await provider.lock()
  const entered = latch()
  const gate = latch()
  cleanups.push(async () => { gate.resolve() })
  vi.mocked(readDocument).mockImplementationOnce(async () => {
    entered.resolve()
    await gate.promise
    return undefined
  })
  const unlocking = expect(provider.unlock(key)).rejects.toThrow(/unlock failed/)
  await entered.promise
  const candidate = vi.mocked(decodeKey).mock.results.at(-1)!.value as Buffer
  const locking = provider.lock()
  expect(candidate.every(byte => byte === 0)).toBe(true)
  gate.resolve()
  await unlocking
  await locking
  expect(provider.status()).toEqual({ locked: true })
})

it('locks on uncertain durability and recovers by reading the committed file', async () => {
  const { provider, key, events } = await boot()
  const actual = await vi.importActual<typeof import('../src/storage.ts')>('../src/storage.ts')
  vi.mocked(writeDocument).mockImplementationOnce(async (...args) => {
    await actual.writeDocument(...args)
    throw new UncertainCommitError()
  })
  await expect(provider.replace({ MODEL_KEY: 'committed' })).rejects.toThrow(/durability uncertain/)
  expect(provider.status()).toEqual({ locked: true })
  expect(events).toEqual([])
  await provider.unlock(key)
  expect(await provider.resolve(REF)).toEqual({ value: 'committed', source: 'encrypted' })
})

it('bounds queued control operations while persistence is blocked', async () => {
  const { provider } = await boot()
  const entered = latch()
  const gate = latch()
  cleanups.push(async () => { gate.resolve() })
  vi.mocked(writeDocument).mockImplementationOnce(async () => {
    entered.resolve()
    await gate.promise
  })
  const first = provider.replace({ MODEL_KEY: 'first' })
  await entered.promise
  const queued = Array.from({ length: 15 }, (_, i) => provider.replace({ MODEL_KEY: `queued-${i}` }))
  const overflow = provider.replace({ MODEL_KEY: 'overflow' })
  // Releasing I/O before awaiting overflow keeps a missing bound from hanging the regression itself.
  gate.resolve()
  await expect(overflow).rejects.toThrow(/busy/)
  await first
  await Promise.all(queued)
  expect(await provider.resolve(REF)).toEqual({ value: 'queued-14', source: 'encrypted' })
})

it('rejects invalid storage configuration and exposes disposal to synchronous callers', async () => {
  expect(() => new EncryptedCredentialProvider(new Context(), { dshHome: '' })).toThrow(/invalid storage path/)
  new EncryptedCredentialProvider(new Context())
  const { provider, fiber } = await boot()
  await fiber.dispose()
  expect(provider.status()).toEqual({ locked: true })
  await expect(provider.set(REF, 'late')).rejects.toThrow(/disposed/)
})
