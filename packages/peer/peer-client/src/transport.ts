/** Stored-transport dialing: resolve one target's origin directly or through its recorded SSH forward. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Agent } from 'undici'
import type { Context } from '@deepseek-ai/cordis'
import { HostRegistry } from '@deepseek-ai/dsh-remote-hosts'
import type { RemoteHostSshAuthentication, RemoteHostSshConnection, RemoteHostSshForward } from '@deepseek-ai/dsh-remote-hosts-ssh'
import type {} from '@deepseek-ai/dsh-remote-hosts-ssh'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerTarget } from '@deepseek-ai/dsh-peer-protocol'

/** One established SSH forward to the target's loopback endpoint. */
interface SshTunnel { port: number; close(): Promise<void> }

/** How one dial reaches its endpoint: directly, or through a named remote-hosts SSH record. */
export type PeerTransportRoute = { kind: 'direct' } | { kind: 'ssh'; host: string }

/** Whether one presented TLS certificate matches the pinned SHA-256 fingerprint.
 * @param pin - base64, 43 characters, from the invitation payload.
 * @param certificate - the peer certificate exactly as TLS presented it.
 * @returns whether the DER-encoded certificate hashes to the pin.
 */
export function verifyTlsFingerprint(pin: string, certificate: { raw: Buffer }): boolean {
  return createHash('sha256').update(certificate.raw).digest('base64') === pin
}

/** Build the TLS identity check enforcing one pinned fingerprint on every connection.
 * @param pin - base64 SHA-256 fingerprint the peer certificate must hash to.
 * @returns a `checkServerIdentity` rejecting every other certificate.
 */
export function pinnedIdentityChecker(pin: string): (hostname: string, certificate: { raw: Buffer }) => Error | undefined {
  return (_hostname, certificate) => verifyTlsFingerprint(pin, certificate)
    ? undefined
    : new Error('peer: PIN_MISMATCH (certificate does not match the pinned fingerprint)')
}

/**
 * Resolve the fetch one target's calls use, enforcing its pinned TLS fingerprint.
 * A pinned target must be reached over HTTPS — directly or through an SSH
 * forward, the certificate verification rides the same TLS connection.
 * @param pin - pinned base64 SHA-256 fingerprint, when the target carries one.
 * @param origin - exact origin the calls dial.
 * @param fetchImpl - transport fetch the pin wraps.
 * @returns the pinned fetch, or the passed fetch when no pin applies.
 * @throws a {@link PeerError} with `PIN_MISMATCH` when a pinned target is dialed over plain HTTP.
 */
export function pinnedFetchFor(
  pin: string | undefined,
  origin: string,
  fetchImpl: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
): typeof globalThis.fetch {
  if (pin === undefined) return fetchImpl
  if (!origin.startsWith('https://')) {
    throw new PeerError('PIN_MISMATCH', 'a pinned target must be reached over HTTPS')
  }
  const agent = new Agent({ connect: { rejectUnauthorized: true, checkServerIdentity: pinnedIdentityChecker(pin) } })
  return (input, init) => fetchImpl(input, { ...init, dispatcher: agent } as RequestInit)
}

/**
 * Run one origin-resolved operation directly or through the recorded SSH forward.
 * @param ctx - caller context the optional SSH provider resolves from.
 * @param home - initiator Harness home holding the remote-hosts registry.
 * @param route - how the endpoint is reached.
 * @param endpointOrigin - the endpoint's stored origin.
 * @param body - operation to run against the resolved origin.
 * @returns the operation's result.
 */
export async function withPeerOrigin<T>(
  ctx: Context,
  home: string,
  route: PeerTransportRoute,
  endpointOrigin: string,
  body: (origin: string) => Promise<T>,
): Promise<T> {
  if (route.kind === 'direct') return await body(endpointOrigin)
  const tunnel = await openSshForward(ctx, home, route.host, endpointOrigin)
  try {
    return await body(`http://127.0.0.1:${String(tunnel.port)}`)
  } finally {
    await tunnel.close()
  }
}

/**
 * Run one stored target's operation directly or through its recorded transport.
 * @param ctx - caller context the optional SSH provider resolves from.
 * @param home - initiator Harness home.
 * @param target - stored target record naming the transport.
 * @param body - operation to run against the resolved origin.
 * @returns the operation's result.
 */
export async function withPeerTransport<T>(
  ctx: Context,
  home: string,
  target: PeerTarget,
  body: (origin: string) => Promise<T>,
): Promise<T> {
  return await withPeerOrigin(ctx, home, target.transport, target.endpoint.origin, body)
}

/**
 * Dial one remote-hosts record and forward the target's loopback endpoint.
 * @param ctx - caller context the optional SSH provider resolves from.
 * @param home - initiator Harness home holding the remote-hosts registry.
 * @param hostName - remote-hosts record name.
 * @param endpointOrigin - the invitation endpoint origin naming the target's loopback port.
 * @returns the live local forward.
 */
async function openSshForward(ctx: Context, home: string, hostName: string, endpointOrigin: string): Promise<SshTunnel> {
  const target = new URL(endpointOrigin)
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.hostname !== '127.0.0.1') {
    throw new Error('peer transport: ssh targets require a loopback http://127.0.0.1:<port> or https://127.0.0.1:<port> invitation endpoint')
  }
  const provider = ctx.get('remoteHostSsh')
  if (provider === undefined) throw new Error('peer transport: the ssh target needs the remote-hosts-ssh service')
  const registry = new HostRegistry(home)
  await registry.load()
  const record = registry.list().find(entry => entry.name === hostName)
  if (record === undefined) throw new Error(`peer transport: no remote host named ${JSON.stringify(hostName)}`)
  const authentication = await sshAuthentication(record.authentication)
  const connection: RemoteHostSshConnection = await provider.open({
    host: record.host,
    port: record.port,
    username: record.username,
    fingerprint: record.fingerprint,
  }, authentication)
  const forward: RemoteHostSshForward = await connection.forward('127.0.0.1', Number(target.port))
  return {
    port: forward.port,
    close: async () => {
      await forward.close()
      await connection.dispose()
    },
  }
}

/**
 * Map one stored host authentication onto an explicit headless SSH credential.
 * @param authentication - stored record authentication.
 * @returns the explicit credential for this dial.
 */
async function sshAuthentication(
  authentication: { kind: 'password'; passwordRef?: string } | { kind: 'key'; privateKeyRef?: string; keyPath?: string; passphraseRef?: string } | { kind: 'agent'; socket: string },
): Promise<RemoteHostSshAuthentication> {
  if (authentication.kind === 'agent') return { kind: 'agent', socket: authentication.socket }
  if (authentication.kind === 'key' && authentication.keyPath !== undefined && authentication.passphraseRef === undefined) {
    return { kind: 'key', privateKey: await readFile(authentication.keyPath, 'utf8') }
  }
  throw new PeerError('UNSUPPORTED_CREDENTIALS', 'headless pairing supports key-file and agent host logins only')
}
