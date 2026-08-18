import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  type AuthenticationCapability,
  type AuthenticationChallengeProof,
  type AuthenticationChallengePurpose,
} from '@deepseek-ai/dsh-authentication'
import {
  approveEnrollmentRequest,
  createEnrollmentRequest,
  type AuthenticationGrant,
  type AuthenticationGrantKind,
} from '../src/grant-registry.ts'

/** Approved test Grant and its private signing key. */
export interface GrantFixture {
  grant: AuthenticationGrant
  privateKey: KeyObject
}

/** Create and locally approve one public-key Grant. */
export async function createGrantFixture(
  dshHome: string,
  name = 'device',
  capabilities: readonly AuthenticationCapability[] = ALL_AUTHENTICATION_CAPABILITIES,
  kind: AuthenticationGrantKind = 'device',
): Promise<GrantFixture> {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  if (kind === 'api-client') throw new Error('test helper enrolls browser device kinds only')
  const request = await createEnrollmentRequest({
    name,
    kind,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  }, { dshHome })
  const grant = await approveEnrollmentRequest(request.id, {
    capabilities,
    ...(kind === 'temporary' && { expiresInMs: 60_000, idleTimeoutMs: 15_000 }),
  }, { dshHome })
  return { grant, privateKey: pair.privateKey }
}

/** Issue and sign one runtime challenge. */
export async function signedProof(
  ctx: Context,
  fixture: GrantFixture,
  purpose: AuthenticationChallengePurpose,
): Promise<AuthenticationChallengeProof> {
  const decision = await ctx.authentication.createChallenge(fixture.grant.id, purpose)
  if (decision.kind !== 'accepted') throw new Error(`challenge rejected: ${decision.reason}`)
  return {
    challengeId: decision.value.id,
    signature: sign('sha256', Buffer.from(decision.value.payload), {
      key: fixture.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
  }
}
