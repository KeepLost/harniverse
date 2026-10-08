/** The owner Grant that Grant provisioning requires: it stands in for the owner's browser device. */

import { generateKeyPairSync } from 'node:crypto'
import { createAuthenticationClientGrant } from '@deepseek-ai/dsh-authentication-local'

/**
 * Register an owner Grant in a Harness home.
 * @param dshHome - Harness home whose Grant registry receives the owner.
 * @param name - Grant name; unique per call by default.
 */
export async function seedOwner(dshHome: string, name = `owner-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`): Promise<void> {
  await createAuthenticationClientGrant({
    name,
    publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    capabilities: ['harniverse.observe', 'harniverse.operate', 'harniverse.administer', 'harniverse.authorize'],
  }, { dshHome })
}
