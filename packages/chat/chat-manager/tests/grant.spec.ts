import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createAuthenticationClientGrant, isAuthenticationGrantActive, listAuthenticationGrants, revokeAuthenticationGrant,
} from '@deepseek-ai/dsh-authentication-local'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import { BridgeUnavailableError } from '../src/errors.ts'
import { ensureBridgeGrant, GRANT_CAPABILITIES, GRANT_NAME, internals } from '../src/grant.ts'
import { MemoryCredentials } from './fixtures/credentials.ts'
import { seedOwner } from './fixtures/owner.ts'

const SIGNING = 'DSH_CHAT_BRIDGE_SIGNING'
const GRANT_ID = 'DSH_CHAT_BRIDGE_GRANT_ID'

let dshHome: string
let credentials: MemoryCredentials
const originalCreate = internals.createGrant

beforeEach(async () => {
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-chat-grant-'))
  credentials = new MemoryCredentials()
})

afterEach(async () => {
  internals.createGrant = originalCreate
  await rm(dshHome, { recursive: true, force: true })
})

function pair(): { privateKey: string; publicKey: string } {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

const seedOwnerGrant = (): Promise<void> => seedOwner(dshHome, 'owner')

const bridgeGrants = async (): Promise<Awaited<ReturnType<typeof listAuthenticationGrants>>> =>
  (await listAuthenticationGrants({ dshHome })).filter(grant => grant.name.startsWith(GRANT_NAME))

describe('bridge Grant provisioning', () => {
  it('registers the least-privilege chat-bridge Grant and stores the key and Grant id', async () => {
    await seedOwnerGrant()
    const result = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    const grants = await bridgeGrants()
    expect(grants).toHaveLength(1)
    const [grant] = grants
    expect(grant).toMatchObject({ name: 'chat-bridge', kind: 'api-client', capabilities: ['harniverse.observe', 'harniverse.operate'] })
    expect(GRANT_CAPABILITIES).toEqual(['harniverse.observe', 'harniverse.operate'])
    expect(result).toEqual({ grantId: grant!.id, keyCreated: true, grantCreated: true })
    expect(credentials.values.get(GRANT_ID)).toBe(grant!.id)
    expect(credentials.values.get(SIGNING)).toMatch(/^[\w-]{80,}$/u)
    expect(isAuthenticationGrantActive(grant!)).toBe(true)
  })

  it('is idempotent: a second call reuses the key and the Grant', async () => {
    await seedOwnerGrant()
    const first = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    const second = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    expect(second).toEqual({ grantId: first.grantId, keyCreated: false, grantCreated: false })
    expect(await bridgeGrants()).toHaveLength(1)
    expect(credentials.calls.filter(call => call.startsWith('set '))).toEqual([`set ${SIGNING}`, `set ${GRANT_ID}`])
  })

  it('reuses credentials and a Grant that `dsh chat init` already created', async () => {
    await seedOwnerGrant()
    const keys = pair()
    const existing = await createAuthenticationClientGrant(
      { name: GRANT_NAME, publicKey: keys.publicKey, capabilities: GRANT_CAPABILITIES }, { dshHome },
    )
    credentials.values.set(SIGNING, keys.privateKey)
    credentials.values.set(GRANT_ID, existing.id)
    const result = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    expect(result).toEqual({ grantId: existing.id, keyCreated: false, grantCreated: false })
    expect(await bridgeGrants()).toHaveLength(1)
    expect(credentials.calls).toEqual([])
  })

  it('adopts the Grant that matches the key when the Grant id credential was lost', async () => {
    await seedOwnerGrant()
    const keys = pair()
    const existing = await createAuthenticationClientGrant(
      { name: GRANT_NAME, publicKey: keys.publicKey, capabilities: GRANT_CAPABILITIES }, { dshHome },
    )
    credentials.values.set(SIGNING, keys.privateKey)
    const result = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    expect(result).toEqual({ grantId: existing.id, keyCreated: false, grantCreated: false })
    expect(credentials.values.get(GRANT_ID)).toBe(existing.id)
    expect(await bridgeGrants()).toHaveLength(1)
  })

  it('registers a replacement when the stored Grant was revoked', async () => {
    await seedOwnerGrant()
    const first = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    await revokeAuthenticationGrant(authenticationGrantId(first.grantId), { dshHome })
    const second = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    expect(second).toMatchObject({ keyCreated: false, grantCreated: true })
    expect(second.grantId).not.toBe(first.grantId)
    expect(credentials.values.get(GRANT_ID)).toBe(second.grantId)
    expect((await bridgeGrants()).map(grant => grant.name)).toEqual(['chat-bridge'])
  })

  it('never adopts a same-named Grant it holds no key for: a timestamped Grant is registered beside it', async () => {
    await seedOwnerGrant()
    const foreign = await createAuthenticationClientGrant(
      { name: GRANT_NAME, publicKey: pair().publicKey, capabilities: GRANT_CAPABILITIES }, { dshHome },
    )
    const result = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    expect(result.grantCreated).toBe(true)
    expect(result.grantId).not.toBe(foreign.id)
    const names = (await bridgeGrants()).map(grant => grant.name)
    expect(names).toHaveLength(2)
    expect(names).toContain('chat-bridge')
    expect(names.find(name => name !== 'chat-bridge')).toMatch(/^chat-bridge-\d{14}$/u)
  })

  it('does not reuse a Grant with narrower capabilities or one that has expired', async () => {
    await seedOwnerGrant()
    const narrow = pair()
    await createAuthenticationClientGrant({ name: 'narrow', publicKey: narrow.publicKey, capabilities: ['harniverse.observe'] }, { dshHome })
    credentials.values.set(SIGNING, narrow.privateKey)
    const first = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    expect(first.grantCreated).toBe(true)

    const expiring = pair()
    await createAuthenticationClientGrant({ name: 'short', publicKey: expiring.publicKey, capabilities: GRANT_CAPABILITIES, expiresInMs: 1 }, { dshHome })
    await new Promise(resolve => setTimeout(resolve, 15))
    credentials.values.set(SIGNING, expiring.privateKey)
    credentials.values.delete(GRANT_ID)
    const second = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    expect(second.grantCreated).toBe(true)
    expect(second.grantId).not.toBe(first.grantId)
  })

  it('refuses a stored signing key that is not a P-256 PKCS#8 key without touching the Grant registry', async () => {
    await seedOwnerGrant()
    credentials.values.set(SIGNING, 'not-a-key')
    await expect(ensureBridgeGrant(credentials.asProvider(), { dshHome })).rejects.toBeInstanceOf(BridgeUnavailableError)
    const ed25519 = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
    credentials.values.set(SIGNING, ed25519)
    await expect(ensureBridgeGrant(credentials.asProvider(), { dshHome })).rejects.toThrow('签名密钥')
    expect(await bridgeGrants()).toEqual([])
  })

  it('asks for the owner device login first when no owner Grant exists, keeping the generated key for the next attempt', async () => {
    const error = await ensureBridgeGrant(credentials.asProvider(), { dshHome }).then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(BridgeUnavailableError)
    expect((error as Error).message).toContain('设备登录')
    expect(credentials.values.has(SIGNING)).toBe(true)
    expect(credentials.values.has(GRANT_ID)).toBe(false)

    await seedOwnerGrant()
    const result = await ensureBridgeGrant(credentials.asProvider(), { dshHome })
    expect(result).toMatchObject({ keyCreated: false, grantCreated: true })
  })

  it('rethrows any other registration failure unchanged', async () => {
    await seedOwnerGrant()
    internals.createGrant = () => Promise.reject(new Error('disk full'))
    await expect(ensureBridgeGrant(credentials.asProvider(), { dshHome })).rejects.toThrow('disk full')
  })
})
