import { expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { generateKeyPairSync } from 'node:crypto'
import { identity, identityRefs, authentication, signingKey, storeAuthentication } from '../src/secrets.ts'
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
