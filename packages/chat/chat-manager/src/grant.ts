/**
 * The Grant the embedded bridge signs in with. It is the same least-privilege
 * Grant `dsh chat init` registers: an API-client Grant named `chat-bridge`
 * that can observe and operate, and nothing more. The manager provisions it
 * the first time a bot starts and reuses whatever `DSH_CHAT_BRIDGE_*`
 * credentials and Grant already exist. It shows in the user's Grants list
 * under that name.
 * @module @deepseek-ai/dsh-chat-manager/grant
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import {
  createAuthenticationClientGrant, isAuthenticationGrantActive, listAuthenticationGrants,
  type AuthenticationGrant,
} from '@deepseek-ai/dsh-authentication-local'
import type { AuthenticationCapability } from '@deepseek-ai/dsh-authentication'
import { DEFAULT_GRANT_ID_REF, DEFAULT_SIGNING_KEY_REF } from '@deepseek-ai/dsh-chat-harniverse-client'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { BridgeUnavailableError } from './errors.ts'

/** Name of the Grant, as `dsh chat init` registers it. */
export const GRANT_NAME = 'chat-bridge'

/** Capabilities the bridge needs and nothing more: streams and prompts. */
export const GRANT_CAPABILITIES: readonly AuthenticationCapability[] = ['harniverse.observe', 'harniverse.operate']

/** Replaceable Grant registration; tests substitute a failing one. */
export const internals: { createGrant: typeof createAuthenticationClientGrant } = {
  createGrant: createAuthenticationClientGrant,
}

/** What one provisioning call did. */
export interface BridgeGrantResult {
  grantId: string
  /** A signing key was generated and stored. */
  keyCreated: boolean
  /** A Grant was registered. */
  grantCreated: boolean
}

interface SigningKey {
  /** PKCS#8 DER, base64url. */
  privateKey: string
  /** SPKI DER, base64url. */
  publicKey: string
}

function generateSigningKey(): SigningKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

/** Parse a stored signing key and derive its public half. */
function signingKeyFrom(privateKey: string): SigningKey {
  let key: ReturnType<typeof createPrivateKey>
  try {
    key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
  } catch (error) {
    throw new BridgeUnavailableError('IM 桥接的签名密钥已损坏，请删除凭据 DSH_CHAT_BRIDGE_SIGNING 后重试', { cause: error })
  }
  if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new BridgeUnavailableError('IM 桥接的签名密钥不是 P-256 密钥，请删除凭据 DSH_CHAT_BRIDGE_SIGNING 后重试')
  }
  return { privateKey, publicKey: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url') }
}

function timestamp(): string {
  return new Date().toISOString().replace(/\D/gu, '').slice(0, 14)
}

/**
 * Ensure the signing key, the Grant, and both credentials exist, idempotently.
 * An existing key is reused; a Grant is reused when it is an active API-client
 * Grant for that key with the full capability set, found by the stored id or
 * else by the key, which also adopts a Grant whose id credential was lost. A
 * revoked or unusable Grant is replaced; a same-named Grant held for another
 * key is left alone and the new one gets a timestamped name.
 * @param credentials - credential provider holding the key and Grant id.
 * @param options - `dshHome` of the authentication provider whose registry receives the Grant.
 * @returns the Grant id and what was created.
 * @throws {BridgeUnavailableError} when the stored key is unusable or no owner Grant exists yet.
 */
export async function ensureBridgeGrant(credentials: CredentialProvider, options: { dshHome: string }): Promise<BridgeGrantResult> {
  const stored = (await credentials.resolve(credentialRef(DEFAULT_SIGNING_KEY_REF)))?.value
  const key = stored === undefined ? generateSigningKey() : signingKeyFrom(stored)
  if (stored === undefined) await credentials.set(credentialRef(DEFAULT_SIGNING_KEY_REF), key.privateKey)

  const grants = await listAuthenticationGrants(options)
  const storedId = (await credentials.resolve(credentialRef(DEFAULT_GRANT_ID_REF)))?.value
  const usable = (grant: AuthenticationGrant): boolean => grant.kind === 'api-client'
    && grant.publicKey === key.publicKey
    && isAuthenticationGrantActive(grant)
    && GRANT_CAPABILITIES.every(capability => grant.capabilities.includes(capability))
  let grant = grants.find(candidate => candidate.id === storedId && usable(candidate)) ?? grants.find(usable)
  const grantCreated = grant === undefined
  if (grant === undefined) {
    const name = grants.some(candidate => candidate.name === GRANT_NAME) ? `${GRANT_NAME}-${timestamp()}` : GRANT_NAME
    try {
      grant = await internals.createGrant({ name, publicKey: key.publicKey, capabilities: GRANT_CAPABILITIES }, options)
    } catch (error) {
      if (error instanceof Error && error.message.includes('first active Grant must authorize')) {
        throw new BridgeUnavailableError('尚未创建所有者：请先在浏览器完成设备登录，再启用 IM 机器人', { cause: error })
      }
      throw error
    }
  }
  if (storedId !== grant.id) await credentials.set(credentialRef(DEFAULT_GRANT_ID_REF), grant.id)
  return { grantId: grant.id, keyCreated: stored === undefined, grantCreated }
}
