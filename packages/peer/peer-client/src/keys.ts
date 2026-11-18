/** Initiator signing identity: one P-256 keypair per home, under `peers/identity.pem`. */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'

/** Public material exported for enrollment. */
export interface PeerKeyMaterial {
  /** Base64url DER SubjectPublicKeyInfo for enrollment and challenge exchange. */
  publicKey: string
  /** Sign one UTF-8 challenge payload as base64url IEEE-P1363 ECDSA/SHA-256.
   * @param payload - challenge payload to sign.
   * @returns the detached signature.
   */
  signChallenge(payload: string): Promise<string>
}


/** Non-secret failure classification for a storage write error.
 * @param error - the thrown failure.
 * @returns the error's constructor name, or a fixed label for non-Error throws.
 */
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : /* v8 ignore next -- every filesystem failure is an Error; the label names the impossible */ 'write failed'
}
/**
 * Resolve the identity key path inside one home.
 * @param home - absolute Harness home directory.
 * @returns the `peers/identity.pem` path.
 */
export function peerIdentityKeyPath(home: string): string {
  return join(home, 'peers', 'identity.pem')
}

/**
 * Load the home's signing key, minting it on first use.
 * @param home - absolute Harness home directory.
 * @returns the key's public material and signing callback.
 */
export async function ensurePeerIdentityKey(home: string): Promise<PeerKeyMaterial> {
  const target = peerIdentityKeyPath(home)
  let pem: string
  try {
    pem = await readFile(target, 'utf8')
  } catch {
    pem = await mintKey(target)
  }
  const privateKey = createPrivateKey(pem)
  if (privateKey.asymmetricKeyType !== 'ec') throw new PeerError('CORRUPT_INSTANCE', 'identity key is not EC')
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url')
  const signChallenge = (payload: string): Promise<string> => Promise.resolve(
    sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'))
  return { publicKey, signChallenge }
}

/**
 * Mint and persist one fresh PKCS#8 P-256 key with owner-only permissions.
 * @param target - exact key path.
 * @returns the persisted PKCS#8 PEM body.
 */
async function mintKey(target: string): Promise<string> {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem: string = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const staging = join(dirname(target), `.identity.pem.${process.pid.toString(36)}`)
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(staging, pem, { mode: 0o600 })
    await rename(staging, target)
  } catch (error) {
    throw new PeerError('STORE_FAILED', failureName(error))
  }
  return pem
}
