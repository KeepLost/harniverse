import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { RemoteHostSshAuthentication } from '@deepseek-ai/dsh-remote-hosts-ssh'
import type { AuthSecrets, HostRecord, RemoteHostId } from './types.ts'
import { RemoteHostsError } from './validation.ts'

function prefix(id: RemoteHostId): string { return `DSH_REMOTE_HOST_${id.replaceAll('-', '_')}` }
/** Return the coordinator-owned credential references for one host.
 * @param id - local host identity.
 * @returns AES and signing credential reference names.
 */
export function identityRefs(id: RemoteHostId): { aes: string; signing: string } {
  return { aes: `${prefix(id)}_AES`, signing: `${prefix(id)}_SIGNING` }
}
async function required(provider: CredentialProvider, ref: string | undefined): Promise<string> {
  if (ref === undefined) throw new RemoteHostsError('CREDENTIAL_REQUIRED')
  const value = await provider.resolve(credentialRef(ref))
  if (value === undefined) throw new RemoteHostsError('CREDENTIAL_REQUIRED')
  return value.value
}
/** Load or create the host's encryption identity.
 * @param provider - local credential provider.
 * @param id - local host identity.
 * @returns AES material and the corresponding public signing key.
 */
export async function identity(provider: CredentialProvider, id: RemoteHostId): Promise<{ aes: string; publicKey: string }> {
  const refs = identityRefs(id)
  let aes = (await provider.resolve(credentialRef(refs.aes)))?.value
  let signing = (await provider.resolve(credentialRef(refs.signing)))?.value
  if (aes === undefined && signing !== undefined) throw new RemoteHostsError('ENCRYPTION_KEY_MISSING')
  if (aes === undefined) {
    aes = randomBytes(32).toString('base64url')
    await provider.set(credentialRef(refs.aes), aes)
  }
  if (signing === undefined) {
    signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
    await provider.set(credentialRef(refs.signing), signing)
  }
  if (Buffer.from(aes, 'base64url').length !== 32 || Buffer.from(aes, 'base64url').toString('base64url') !== aes) throw new RemoteHostsError('INVALID_ENCRYPTION_KEY')
  const privateKey = createPrivateKey({ key: Buffer.from(signing, 'base64url'), format: 'der', type: 'pkcs8' })
  if (privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new RemoteHostsError('INVALID_SIGNING_KEY')
  return { aes, publicKey: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url') }
}
/** Resolve the host's signing private key.
 * @param provider - local credential provider.
 * @param id - local host identity.
 * @returns the parsed signing key.
 */
export async function signingKey(provider: CredentialProvider, id: RemoteHostId): Promise<KeyObject> {
  return createPrivateKey({ key: Buffer.from(await required(provider, identityRefs(id).signing), 'base64url'), format: 'der', type: 'pkcs8' })
}

/**
 * Store login secrets under fresh immutable references so failed registry
 * commits cannot replace the old login.
 * @param provider - local credential provider.
 * @param host - current host record.
 * @param secrets - submitted login secret.
 * @returns host record updated with fresh credential references.
 */
export async function storeAuthentication(provider: CredentialProvider, host: HostRecord, secrets: AuthSecrets): Promise<HostRecord> {
  if (host.authentication.kind !== secrets.kind) throw new RemoteHostsError('AUTH_KIND_MISMATCH')
  const tag = `${prefix(host.id)}_LOGIN_${randomUUID().replaceAll('-', '_')}`
  if (secrets.kind === 'password') {
    await provider.set(credentialRef(`${tag}_PASSWORD`), secrets.password)
    return { ...host, authentication: { kind: 'password', passwordRef: `${tag}_PASSWORD` } }
  }
  await provider.set(credentialRef(`${tag}_KEY`), secrets.privateKey)
  if (secrets.passphrase !== undefined) await provider.set(credentialRef(`${tag}_PASSPHRASE`), secrets.passphrase)
  return { ...host, authentication: { kind: 'key', privateKeyRef: `${tag}_KEY`,
    ...(secrets.passphrase === undefined ? {} : { passphraseRef: `${tag}_PASSPHRASE` }) } }
}

/** Resolve explicit or stored SSH authentication material.
 * @param provider - local credential provider.
 * @param host - configured host record.
 * @param secrets - optional one-shot login secret.
 * @returns transport authentication options.
 */
export async function authentication(
  provider: CredentialProvider, host: HostRecord, secrets?: AuthSecrets,
): Promise<RemoteHostSshAuthentication> {
  if (secrets !== undefined) {
    if (secrets.kind !== host.authentication.kind) throw new RemoteHostsError('AUTH_KIND_MISMATCH')
    return { ...secrets }
  }
  const auth = host.authentication
  switch (auth.kind) {
    case 'agent': return { kind: 'agent', socket: auth.socket }
    case 'password': return { kind: 'password', password: await required(provider, auth.passwordRef) }
    case 'key': return { kind: 'key', privateKey: await required(provider, auth.privateKeyRef),
      ...(auth.passphraseRef === undefined ? {} : { passphrase: await required(provider, auth.passphraseRef) }) }
  }
}
