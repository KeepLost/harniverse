/** One-shot peer pairing runner. */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  issueEnrollmentInvitation,
  listAuthenticationGrants,
  revokeAuthenticationGrant,
} from '@deepseek-ai/dsh-authentication-local'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import type {} from '@deepseek-ai/dsh-cmdline'
import {
  PEER_CAPABILITY,
  PEER_ENROLLMENT_KIND,
  PeerError,
  decodePeerInvite,
  ensureInstanceIdentity,
  encodePeerInvite,
  peerGrantName,
  peerInstanceId,
  validateOrigin,
} from '@deepseek-ai/dsh-peer-protocol'
import { pairWithPeer, readPeerTargets, writePeerTargets } from '@deepseek-ai/dsh-peer-client'
import { findPeer, readPeerStore, writePeerStore } from '@deepseek-ai/dsh-peer-host'
import { HostRegistry } from '@deepseek-ai/dsh-remote-hosts'
import type { RemoteHostSshAuthentication, RemoteHostSshConnection, RemoteHostSshForward } from '@deepseek-ai/dsh-remote-hosts-ssh'
import type {} from '@deepseek-ai/dsh-remote-hosts-ssh'
import type { PeerOperation, PeerStartupValues } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'peer-runner'

/** Parsed app invocation required before pairing starts. */
export const inject = ['peerStartup', 'remoteHostSsh']

/** Peer pairing runner configuration. */
export interface Config extends PeerStartupValues {
  /** Harness home of this instance. */
  dshHome?: string
}

/** Loader validation for the runner row. */
export const Config: z<Config> = z.object({
  operation: z.union([
    z.const('invite'), z.const('add'), z.const('list'),
    z.const('remove'), z.const('targets'), z.const('forget'),
  ]).required(),
  uri: z.string(),
  endpoint: z.string(),
  displayName: z.string(),
  ttl: z.string(),
  fingerprint: z.string(),
  sshHost: z.string(),
  instanceId: z.string(),
  timeoutMs: z.natural(),
  dshHome: z.string(),
})

interface TextOutput {
  write(value: string): unknown
}

/** Process streams used by the runner; tests replace them with captures. */
export const internals: { stdout: TextOutput; stderr: TextOutput } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * Parse one invitation lifetime expression.
 * @param value - `<n>s`, `<n>m`, `<n>h`, `<n>d`, or bare milliseconds.
 * @returns the lifetime in milliseconds.
 */
function parseDurationMs(value: string): number {
  const match = /^(\d+)(s|m|h|d)?$/.exec(value)
  if (match === null) {
    throw new Error('peer-runner: --ttl accepts <n>s, <n>m, <n>h, <n>d, or milliseconds')
  }
  const scale = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? 'ms'] ?? 1
  return Number(match[1]) * scale
}

function required(value: string | undefined, operation: PeerOperation, field: string): string {
  if (value === undefined) throw new Error(`peer-runner: ${operation} requires ${field}`)
  return value
}

/** Execute one operation and request bounded process exit. */
async function run(config: Config, ctx: Context, exit: (code: number) => void): Promise<void> {
  const home = required(config.dshHome, config.operation, 'a Harness home')
  switch (config.operation) {
    case 'invite': {
      const origin = validateOrigin({ origin: required(config.endpoint, config.operation, '--endpoint') })
      const identity = await ensureInstanceIdentity(home)
      const ttlMs = parseDurationMs(config.ttl ?? '10m')
      const invitation = await issueEnrollmentInvitation({
        capabilities: [PEER_CAPABILITY],
        kind: PEER_ENROLLMENT_KIND,
        ttlMs,
      }, { dshHome: home })
      const uri = encodePeerInvite({
        version: 1,
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        endpoint: { origin },
        ...(config.fingerprint !== undefined && { tlsFingerprint: fingerprintValue(config.fingerprint) }),
        token: invitation.token,
      })
      internals.stdout.write(`${uri}\n`)
      internals.stdout.write(`expires\t${invitation.expiresAt}\n`)
      break
    }
    case 'add': {
      const invite = decodePeerInvite(required(config.uri, config.operation, 'an invitation URI'))
      /* v8 ignore next -- commander owns the 30000 default; direct API callers always pass a timeout */
      const timeoutMs = config.timeoutMs ?? 30_000
      if (config.sshHost === undefined) {
        const result = await pairWithPeer({ invite, home, origin: invite.endpoint.origin, timeoutMs })
        internals.stdout.write(`paired\t${result.hello.displayName}\t${result.hello.instanceId}\t${result.grantId}\n`)
      } else {
        const tunnel = await openSshForward(ctx, home, config.sshHost, invite.endpoint.origin)
        try {
          const result = await pairWithPeer({
            invite, home, origin: `http://127.0.0.1:${String(tunnel.port)}`, timeoutMs,
            transport: { kind: 'ssh', host: config.sshHost },
          })
          internals.stdout.write(`paired\t${result.hello.displayName}\t${result.hello.instanceId}\t${result.grantId}\n`)
        } finally {
          await tunnel.close()
        }
      }
      break
    }
    case 'list': {
      for (const peer of await readPeerStore(home)) {
        internals.stdout.write(`${peer.instanceId}\t${peer.displayName}\t${peer.platform}/${peer.arch}\t${peer.status}\t${peer.lastSeenAt}\n`)
      }
      break
    }
    case 'remove': {
      const id = peerInstanceId(required(config.instanceId, config.operation, 'an instance id'))
      const peers = await readPeerStore(home)
      const existing = findPeer(peers, id)
      if (existing === undefined) throw new PeerError('RECORD_NOT_FOUND')
      await writePeerStore(home, peers.filter(peer => peer.instanceId !== id))
      const grants = await listAuthenticationGrants({ dshHome: home })
      const grant = grants.find(entry => entry.name === peerGrantName(id))
      if (grant !== undefined) await revokeAuthenticationGrant(authenticationGrantId(grant.id), { dshHome: home })
      internals.stdout.write(`removed\t${id}\n`)
      break
    }
    case 'targets': {
      for (const target of await readPeerTargets(home)) {
        internals.stdout.write(`${target.targetInstanceId}\t${target.displayName}\t${target.endpoint.origin}\t${target.transport.kind}\t${target.status}\n`)
      }
      break
    }
    case 'forget': {
      const id = peerInstanceId(required(config.instanceId, config.operation, 'an instance id'))
      const targets = await readPeerTargets(home)
      const existing = targets.find(target => target.targetInstanceId === id)
      if (existing === undefined) throw new PeerError('RECORD_NOT_FOUND')
      await writePeerTargets(home, targets.filter(target => target.targetInstanceId !== id))
      internals.stdout.write(`forgot\t${id}\n`)
      break
    }
  }
  exit(0)
}

/**
 * Map one raw CLI fingerprint value onto the payload shape after validation.
 * @param value - base64 SHA-256 certificate fingerprint.
 * @returns the validated fingerprint.
 */
function fingerprintValue(value: string): string {
  if (!/^[A-Za-z0-9+/]{43}$/.test(value)) throw new Error('peer-runner: --fingerprint must be base64 SHA-256 (43 characters)')
  return value
}

/** One established SSH forward to the target's loopback endpoint. */
interface SshTunnel { port: number; close(): Promise<void> }

/**
 * Dial one remote-hosts record and forward the target's loopback endpoint.
 * @param ctx - app context carrying the SSH provider.
 * @param home - initiator Harness home holding the remote-hosts registry.
 * @param hostName - remote-hosts record name.
 * @param endpointOrigin - the invitation endpoint origin naming the target's loopback port.
 * @returns the live local forward.
 */
async function openSshForward(ctx: Context, home: string, hostName: string, endpointOrigin: string): Promise<SshTunnel> {
  const target = new URL(endpointOrigin)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') {
    throw new Error('peer-runner: --ssh-host requires an http://127.0.0.1:<port> invitation endpoint')
  }
  const registry = new HostRegistry(home)
  await registry.load()
  const record = registry.list().find(entry => entry.name === hostName)
  if (record === undefined) throw new Error(`peer-runner: no remote host named ${JSON.stringify(hostName)}`)
  const authentication = await sshAuthentication(record.authentication)
  const connection: RemoteHostSshConnection = await ctx.remoteHostSsh.open({
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

/**
 * Register the runner and execute the selected operation.
 * @param ctx - plugin context carrying the launcher's exit request.
 * @param config - runner configuration from the startup service.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('peer-runner: the launcher must provide ctx.appExit before the tree mounts')
  void run(config, ctx, exit).catch((error: unknown) => {
    // Every run failure is an Error; the String fallback names non-Error throws.
    /* v8 ignore next */
    const message = error instanceof Error ? error.message : String(error)
    internals.stderr.write(`${message}\n`)
    exit(1)
  })
}
