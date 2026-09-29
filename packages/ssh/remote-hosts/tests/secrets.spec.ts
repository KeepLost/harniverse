import { expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authentication, identity, identityRefs, readKeyFile, resolveKeySecrets, signingKey, storeAuthentication } from '../src/secrets.ts'
import { remoteHostId } from '../src/validation.ts'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { HostRecord } from '../src/types.ts'

const id = remoteHostId('84fbdabb-7814-4d13-a19a-5afeb7b1eb50')
const host: HostRecord = {
  id, name: 'Fixture', host: 'fixture.invalid', port: 22, username: 'runner',
  fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', platform: 'linux', architecture: 'x64',
  authentication: { kind: 'password' }, reverseMappings: [],
}

function provider(values: Record<string, string> = {}) {
  const store = new Map(Object.entries(values))
  return {
    store,
    value: {
      resolve: async (ref: string) => store.has(ref) ? { value: store.get(ref)! } : undefined,
      set: async (ref: string, value: string) => { store.set(ref, value) },
    } as unknown as CredentialProvider,
  }
}

it('creates and reuses encryption and signing identities', async () => {
  const fixture = provider()
  const first = await identity(fixture.value, id)
  expect(Buffer.from(first.aes, 'base64url')).toHaveLength(32)
  expect((await signingKey(fixture.value, id)).type).toBe('private')
  expect(await identity(fixture.value, id)).toEqual(first)
})

it('rejects incomplete or malformed persisted identities', async () => {
  const refs = identityRefs(id)
  const missingEncryption = provider({ [refs.signing]: 'present-but-no-aes' })
  await expect(identity(missingEncryption.value, id)).rejects.toThrow('ENCRYPTION_KEY_MISSING')
  const invalid = provider({ [refs.aes]: 'bad', [refs.signing]: 'bad' })
  await expect(identity(invalid.value, id)).rejects.toThrow('INVALID_ENCRYPTION_KEY')
  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey
    .export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  const wrongIdentity = provider({ [refs.aes]: Buffer.alloc(32).toString('base64url'), [refs.signing]: wrongCurve })
  await expect(identity(wrongIdentity.value, id)).rejects.toThrow('INVALID_SIGNING_KEY')
  await expect(signingKey(provider().value, id)).rejects.toThrow('CREDENTIAL_REQUIRED')
})

it('stores and resolves password, key, and agent authentication forms', async () => {
  const fixture = provider()
  const password = await storeAuthentication(fixture.value, host, { kind: 'password', password: 'secret' })
  expect(await authentication(fixture.value, password)).toEqual({ kind: 'password', password: 'secret' })
  const key = await storeAuthentication(fixture.value, { ...host, authentication: { kind: 'key' } },
    { kind: 'key', privateKey: 'private', passphrase: 'phrase' })
  expect(await authentication(fixture.value, key)).toEqual({ kind: 'key', privateKey: 'private', passphrase: 'phrase' })
  const keyWithoutPassphrase = await storeAuthentication(fixture.value, { ...host, authentication: { kind: 'key' } },
    { kind: 'key', privateKey: 'private-2' })
  expect(await authentication(fixture.value, keyWithoutPassphrase)).toEqual({ kind: 'key', privateKey: 'private-2' })
  const agent: HostRecord = { ...host, authentication: { kind: 'agent', socket: '/tmp/agent.sock' } }
  expect(await authentication(fixture.value, agent)).toEqual({ kind: 'agent', socket: '/tmp/agent.sock' })
  await expect(storeAuthentication(fixture.value, host, { kind: 'key', privateKey: 'private' })).rejects.toThrow('AUTH_KIND_MISMATCH')
  await expect(authentication(fixture.value, host, { kind: 'key', privateKey: 'private' })).rejects.toThrow('AUTH_KIND_MISMATCH')
  await expect(authentication(fixture.value, host)).rejects.toThrow('CREDENTIAL_REQUIRED')
  expect(fixture.store.has(credentialRef(key.authentication.kind === 'key' ? key.authentication.privateKeyRef! : 'missing'))).toBe(true)
})

it('keeps a path-based key login a path and reads the file at use time', async () => {
  const fixture = provider()
  const keyPath = join(await mkdtemp(join(tmpdir(), 'remote-hosts-keypath-')), 'id_ed25519')
  try {
    await writeFile(keyPath, 'PATH KEY MATERIAL')
    const stored = await storeAuthentication(fixture.value, { ...host, authentication: { kind: 'key' } },
      { kind: 'key', privateKeyPath: keyPath, passphrase: 'phrase' })
    // The path is host configuration, not a secret: it stays in the record and no key material is stored.
    expect(stored.authentication.kind).toBe('key')
    expect((stored.authentication as { keyPath?: string }).keyPath).toBe(keyPath)
    expect(typeof (stored.authentication as { passphraseRef?: string }).passphraseRef).toBe('string')
    expect([...fixture.store.keys()].filter(ref => ref.endsWith('_KEY'))).toEqual([])
    // Resolution reads the file on this host at use time.
    await expect(authentication(fixture.value, stored)).resolves.toEqual({ kind: 'key', privateKey: 'PATH KEY MATERIAL', passphrase: 'phrase' })
    const storedWithoutPassphrase = await storeAuthentication(fixture.value, { ...host, authentication: { kind: 'key' } },
      { kind: 'key', privateKeyPath: keyPath })
    await expect(authentication(fixture.value, storedWithoutPassphrase)).resolves.toEqual({ kind: 'key', privateKey: 'PATH KEY MATERIAL' })

    // Explicit one-shot path secrets resolve through the same read.
    await expect(resolveKeySecrets({ kind: 'key', privateKeyPath: keyPath, passphrase: 'phrase' }))
      .resolves.toEqual({ kind: 'key', privateKey: 'PATH KEY MATERIAL', passphrase: 'phrase' })
    await expect(resolveKeySecrets({ kind: 'key', privateKeyPath: keyPath }))
      .resolves.toEqual({ kind: 'key', privateKey: 'PATH KEY MATERIAL' })
    await expect(resolveKeySecrets({ kind: 'password', password: 'secret' })).resolves.toEqual({ kind: 'password', password: 'secret' })
    await expect(resolveKeySecrets({ kind: 'key', privateKey: 'inline' })).resolves.toEqual({ kind: 'key', privateKey: 'inline' })

    // An unreadable file is a closed read failure, and the bound holds at the read.
    await expect(readKeyFile(join(keyPath, '..', 'missing'))).rejects.toThrow('KEY_FILE_READ_FAILED')
    await expect(authentication(fixture.value, { ...host, authentication: { kind: 'key', keyPath: join(keyPath, '..', 'missing') } }))
      .rejects.toThrow('KEY_FILE_READ_FAILED')
    const oversized = join(keyPath, '..', 'oversized')
    await writeFile(oversized, 'x'.repeat(65_537))
    await expect(readKeyFile(oversized)).rejects.toThrow('KEY_FILE_TOO_LARGE')
    const directory = join(keyPath, '..')
    await expect(readKeyFile(directory)).rejects.toThrow('KEY_FILE_READ_FAILED')
  } finally {
    await rm(join(keyPath, '..'), { recursive: true, force: true })
  }
})
