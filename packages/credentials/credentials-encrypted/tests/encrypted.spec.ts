import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { randomBytes } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EncryptedCredentialProvider from '../src/index.ts'

const MODEL = credentialRef('MODEL_KEY')
const SEARCH = credentialRef('SEARCH_KEY')
const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length) await cleanups.pop()!()
})

async function filename(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-encrypted-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'private', 'credentials.json')
}

async function boot(path: string) {
  const ctx = new Context()
  const fiber = ctx.plugin(EncryptedCredentialProvider, { path })
  cleanups.push(() => fiber.dispose())
  await fiber
  const provider = ctx.credentials
  expect(provider).toBeInstanceOf(EncryptedCredentialProvider)
  if (!(provider instanceof EncryptedCredentialProvider)) throw new Error('provider missing')
  const events: string[] = []
  ctx.on('credentials/updated', (ref) => { events.push(ref) })
  return { ctx, fiber, provider, events }
}

describe('encrypted credential authority', () => {
  it('commits exact snapshots and deletion notifications, keeping the old snapshot on write failure', async () => {
    const path = await filename()
    const { provider, events, ctx } = await boot(path)
    await provider.unlock(randomBytes(32).toString('base64url'))
    await provider.replace({ MODEL_KEY: 'old', SEARCH_KEY: 'search' })
    events.length = 0
    const before = await readFile(path, 'utf8')
    await rename(path, `${path}.saved`)
    await mkdir(path)
    await expect(provider.replace({ MODEL_KEY: 'failed' })).rejects.toThrow(/persist/)
    expect(events).toEqual([])
    expect(await provider.resolve(MODEL)).toEqual({ value: 'old', source: 'encrypted' })
    expect(await provider.resolve(SEARCH)).toEqual({ value: 'search', source: 'encrypted' })
    await rm(path, { recursive: true })
    await rename(`${path}.saved`, path)
    expect(await readFile(path, 'utf8')).toBe(before)
    const observations: Array<Promise<unknown>> = []
    ctx.on('credentials/updated', () => { observations.push(provider.resolve(SEARCH)) })
    const snapshot = { MODEL_KEY: 'new' }
    const replacement = provider.replace(snapshot)
    snapshot.MODEL_KEY = 'mutated-after-admission'
    await replacement
    expect(events).toEqual(['MODEL_KEY', 'SEARCH_KEY'])
    expect(await Promise.all(observations)).toEqual([undefined, undefined])
    expect(await provider.resolve(MODEL)).toEqual({ value: 'new', source: 'encrypted' })
    events.length = 0
    await provider.replace({ MODEL_KEY: 'new' })
    expect(events).toEqual([])
    await provider.replace({})
    expect(events).toEqual(['MODEL_KEY'])
    expect(await provider.resolve(MODEL)).toBeUndefined()
  })

  it('takes over the mirror for a different authority and rebuilds it with the next replace', async () => {
    const path = await filename()
    const { provider, events } = await boot(path)
    const first = randomBytes(32).toString('base64url')
    const second = randomBytes(32).toString('base64url')
    await provider.unlock(first)
    await provider.replace({ MODEL_KEY: 'first-authority' })
    events.length = 0
    await provider.takeover(second)
    expect(provider.status()).toEqual({ locked: false })
    expect(await provider.resolve(MODEL)).toBeUndefined()
    expect(events).toEqual([])
    await expect(access(path)).rejects.toThrow(/ENOENT/)
    await provider.replace({ SEARCH_KEY: 'second-authority' })
    expect(await provider.resolve(SEARCH)).toEqual({ value: 'second-authority', source: 'encrypted' })
    await provider.takeover(second)
    expect(await provider.resolve(SEARCH)).toEqual({ value: 'second-authority', source: 'encrypted' })
    await provider.lock()
    await provider.unlock(second)
    expect(await provider.resolve(SEARCH)).toEqual({ value: 'second-authority', source: 'encrypted' })
    await provider.lock()
    await expect(provider.unlock(first)).rejects.toThrow('credentials-encrypted: unlock failed')
  })

  it.each(['wrong-version', 'tampered', 'malformed', 'oversized'])('denies %s files without exposing their contents', async (fault) => {
    const path = await filename()
    const { provider } = await boot(path)
    const key = randomBytes(32).toString('base64url')
    await provider.unlock(key)
    await provider.replace({ MODEL_KEY: 'sensitive-value' })
    await provider.lock()
    const envelope = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (fault === 'wrong-version') envelope.version = 2
    if (fault === 'tampered') envelope.tag = randomBytes(16).toString('base64url')
    const text = fault === 'malformed' ? '{sensitive-value' : fault === 'oversized' ? 'x'.repeat(1_500_001) : JSON.stringify(envelope)
    await writeFile(path, text)
    await expect(provider.unlock(key)).rejects.toThrow('credentials-encrypted: unlock failed')
    expect(provider.status()).toEqual({ locked: true })
    await expect(provider.resolve(MODEL)).rejects.toThrow(/locked/)
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it.each(['', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + 'B'])('rejects noncanonical keys without retaining them (%#)', async (key) => {
    const { provider } = await boot(await filename())
    await expect(provider.unlock(key)).rejects.toThrow(/32-byte.*base64url/)
    expect(provider.status()).toEqual({ locked: true })
  })

  it('rejects invalid or oversized snapshots without changing stored state', async () => {
    const { provider } = await boot(await filename())
    await provider.unlock(randomBytes(32).toString('base64url'))
    await provider.replace({ MODEL_KEY: 'old' })
    const cases: unknown[] = [null, [], { MODEL_KEY: '' }, { MODEL_KEY: 2 }, { 'bad-name': 'value' },
      { MODEL_KEY: '界'.repeat(21_846) }, Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`K${i}`, 'v'])),
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`K${i}`, 'v'.repeat(65_536)]))]
    for (const values of cases) {
      await expect(provider.replace(values as Record<string, string>)).rejects.toThrow(/snapshot/)
    }
    expect(await provider.resolve(MODEL)).toEqual({ value: 'old', source: 'encrypted' })
  })

  it('locks explicitly and permanently closes a disposed instance', async () => {
    const { provider, fiber } = await boot(await filename())
    const key = randomBytes(32).toString('base64url')
    await provider.unlock(key)
    await provider.replace({ MODEL_KEY: 'old' })
    await provider.lock()
    expect(provider.status()).toEqual({ locked: true })
    expect(await provider.describe(MODEL)).toEqual({ configured: false, writable: false })
    await provider.unlock(key)
    await fiber.dispose()
    expect(provider.status()).toEqual({ locked: true })
    await expect(provider.resolve(MODEL)).rejects.toThrow(/disposed/)
    await expect(provider.unlock(key)).rejects.toThrow(/disposed/)
    await expect(provider.replace({})).rejects.toThrow(/disposed/)
    await provider.lock()
  })

  it.skipIf(process.platform === 'win32')('rejects a broadly readable file on unlock', async () => {
    const path = await filename()
    const { provider } = await boot(path)
    const key = randomBytes(32).toString('base64url')
    await provider.unlock(key)
    await provider.replace({ MODEL_KEY: 'value' })
    await provider.lock()
    await chmod(path, 0o644)
    await expect(provider.unlock(key)).rejects.toThrow(/unlock failed/)
  })

  it('boots locked without reading a corrupt store and rejects resolution immediately', async () => {
    const path = await filename()
    await mkdir(path, { recursive: true })
    const { provider } = await boot(path)
    vi.stubEnv('MODEL_KEY', 'ambient-must-not-win')
    expect(provider.status()).toEqual({ locked: true })
    await expect(provider.resolve(MODEL)).rejects.toThrow(/locked/)
    await expect(provider.replace({ MODEL_KEY: 'one' })).rejects.toThrow(/locked/)
    expect(await provider.describe(MODEL)).toEqual({ configured: false, writable: false })
    await expect(provider.set(MODEL, 'one')).rejects.toThrow(/local authority/)
    await expect(provider.unset(MODEL)).rejects.toThrow(/local authority/)
  })

  it('persists only ciphertext with private modes, fresh IVs, and a locked restart', async () => {
    const path = await filename()
    const key = randomBytes(32).toString('base64url')
    const first = await boot(path)
    await first.provider.unlock(key)
    await first.provider.replace({ MODEL_KEY: 'synthetic-model-secret', SEARCH_KEY: '搜索密钥' })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('synthetic-model-secret')
    expect(text).not.toContain('搜索密钥')
    expect(text).not.toContain('MODEL_KEY')
    expect(text).not.toContain(key)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700)
    }
    await first.provider.replace({ MODEL_KEY: 'synthetic-model-secret', SEARCH_KEY: '搜索密钥' })
    const nextEnvelope = JSON.parse(await readFile(path, 'utf8')) as { iv: string }
    expect(nextEnvelope.iv).not.toBe((JSON.parse(text) as { iv: string }).iv)
    await first.fiber.dispose()
    const next = await boot(path)
    await expect(next.provider.resolve(MODEL)).rejects.toThrow(/locked/)
    await expect(next.provider.unlock(randomBytes(32).toString('base64url'))).rejects.toThrow(/unlock failed/)
    expect(next.provider.status()).toEqual({ locked: true })
    await next.provider.unlock(key)
    expect(await next.provider.resolve(MODEL)).toEqual({ value: 'synthetic-model-secret', source: 'encrypted' })
    expect(await next.provider.describe(SEARCH)).toEqual({ configured: true, source: 'encrypted', writable: false })
  })
})
