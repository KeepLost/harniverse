/** One-shot peer pairing runner. */

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
import type { PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import {
  ensurePeerIdentityKey,
  pairWithPeer,
  readPeerTargets,
  runPeerDelegate,
  runPeerCancel,
  runPeerFollowup,
  runPeerResult,
  runPeerSessions,
  runPeerSurface,
  withPeerOrigin,
  withPeerTransport,
  writePeerTargets,
} from '@deepseek-ai/dsh-peer-client'
import { peerOutboxDomainSpec } from '@deepseek-ai/dsh-peer-outbox/spec'
// Declaration merge only: makes ctx.storageDomain visible for the outbox read.
import type {} from '@deepseek-ai/dsh-storage-domain'
import { findPeer, readPeerStore, writePeerStore } from '@deepseek-ai/dsh-peer-host'
import type { PeerOperation, PeerStartupValues } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'peer-runner'

/** Parsed app invocation plus the ledger store required before pairing starts. */
export const inject = ['peerStartup', 'remoteHostSsh', 'storageDomain']

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
    z.const('cancel'), z.const('run'), z.const('send'), z.const('sessions'),
    z.const('result'), z.const('surface'), z.const('outbox'),
  ]).required(),
  uri: z.string(),
  endpoint: z.string(),
  displayName: z.string(),
  ttl: z.string(),
  fingerprint: z.string(),
  sshHost: z.string(),
  instanceId: z.string(),
  timeoutMs: z.natural(),
  prompt: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  profile: z.string(),
  messageId: z.string(),
  surface: z.object({ delegate: z.boolean(), message: z.boolean(), list: z.boolean() }),
  async: z.boolean(),
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
      const tlsFingerprint = config.fingerprint === undefined ? undefined : fingerprintValue(config.fingerprint)
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
        ...(tlsFingerprint !== undefined && { tlsFingerprint }),
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
        const route = { kind: 'ssh', host: config.sshHost } as const
        const result = await withPeerOrigin(ctx, home, route, invite.endpoint.origin,
          origin => pairWithPeer({ invite, home, origin, timeoutMs, transport: route }))
        internals.stdout.write(`paired\t${result.hello.displayName}\t${result.hello.instanceId}\t${result.grantId}\n`)
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
    case 'run': {
      const target = await resolveTarget(config)
      const identity = await ensureInstanceIdentity(home)
      const key = await ensurePeerIdentityKey(home)
      const budget = config.async === true ? 1 : settleBudget(config.timeoutMs ?? 600_000)
      const result = await withPeerTransport(ctx, home, target, origin => runPeerDelegate(
        { target, home, origin, ...(config.timeoutMs !== undefined && { timeoutMs: boundCallTimeout(config.timeoutMs) }) },
        { instanceId: identity.instanceId, key },
        required(config.prompt, config.operation, 'a prompt'),
        { ...(config.cwd !== undefined && { cwd: config.cwd }), ...(config.profile !== undefined && { profile: config.profile }),
          timeoutMs: budget },
      ))
      writeRunResult(result)
      writeReceiptHint(config, result)
      break
    }
    case 'send': {
      const target = await resolveTarget(config)
      const identity = await ensureInstanceIdentity(home)
      const key = await ensurePeerIdentityKey(home)
      const sessionId = required(config.sessionId, config.operation, 'a session id')
      const budget = config.async === true ? 1 : settleBudget(config.timeoutMs ?? 600_000)
      const result = await withPeerTransport(ctx, home, target, origin => runPeerFollowup(
        { target, home, origin, ...(config.timeoutMs !== undefined && { timeoutMs: boundCallTimeout(config.timeoutMs) }) },
        { instanceId: identity.instanceId, key },
        sessionId,
        required(config.prompt, config.operation, 'a prompt'),
        budget,
      ))
      writeRunResult(result)
      writeReceiptHint(config, result)
      break
    }
    case 'cancel': {
      const target = await resolveTarget(config)
      const identity = await ensureInstanceIdentity(home)
      const key = await ensurePeerIdentityKey(home)
      const result = await withPeerTransport(ctx, home, target, origin => runPeerCancel(
        { target, home, origin },
        { instanceId: identity.instanceId, key },
        required(config.sessionId, config.operation, 'a session id'),
      ))
      writeRunResult(result)
      break
    }
    case 'result': {
      const target = await resolveTarget(config)
      const identity = await ensureInstanceIdentity(home)
      const key = await ensurePeerIdentityKey(home)
      const result = await withPeerTransport(ctx, home, target, origin => runPeerResult(
        { target, home, origin },
        { instanceId: identity.instanceId, key },
        required(config.sessionId, config.operation, 'a session id'),
        required(config.messageId, config.operation, 'a message id'),
      ))
      writeRunResult(result)
      break
    }
    case 'surface': {
      const target = await resolveTarget(config)
      const identity = await ensureInstanceIdentity(home)
      const key = await ensurePeerIdentityKey(home)
      /* v8 ignore next 3 -- the CLI flags and the zod schema both guarantee the surface; the guard names loader-direct misconfiguration */
      if (config.surface === undefined) {
        throw new Error(`peer surface: ${config.operation} needs a complete surface`)
      }
      const desired = config.surface
      const outcome = await withPeerTransport(ctx, home, target, origin => runPeerSurface(
        { target, home, origin },
        { instanceId: identity.instanceId, key },
        desired,
      ))
      const grants = `${outcome.surface.delegate ? 'delegate' : 'no-delegate'}, ${outcome.surface.message ? 'message' : 'no-message'}, ${outcome.surface.list ? 'list' : 'no-list'}`
      internals.stdout.write(outcome.pending
        ? `pending owner approval (current: ${grants})\n`
        : `committed (${grants})\n`)
      break
    }
    case 'outbox': {
      const domain = await ctx.storageDomain.open(peerOutboxDomainSpec)
      try {
        const entries = [...domain.table('entries').entries()].map(([, entry]) => entry)
          .sort((a, b) => a.submittedAt - b.submittedAt)
        for (const entry of entries) {
          internals.stdout.write(`${entry.id}\t${entry.state}\t${entry.targetDisplayName}\t${entry.peerSessionId}\t${entry.label}\n`)
        }
      } finally {
        await domain.close()
      }
      break
    }
    case 'sessions': {
      const target = await resolveTarget(config)
      const identity = await ensureInstanceIdentity(home)
      const key = await ensurePeerIdentityKey(home)
      const sessions = await withPeerTransport(ctx, home, target, origin => runPeerSessions(
        { target, home, origin },
        { instanceId: identity.instanceId, key },
      ))
      for (const entry of sessions) {
        internals.stdout.write(`${entry.sessionId}\t${entry.state}\t${entry.lastActivityAt}\t${entry.label}\n`)
      }
      break
    }
  }
  exit(0)
}

/** Resolve the paired target record one delegation operation addresses.
 * @param config - runner configuration naming the target instance.
 * @returns the stored active target record.
 */
async function resolveTarget(config: Config): Promise<PeerTarget> {
  const id = peerInstanceId(required(config.instanceId, config.operation, 'an instance id'))
  const target = (await readPeerTargets(required(config.dshHome, config.operation, 'a Harness home')))
    .find(entry => entry.targetInstanceId === id && entry.status === 'active')
  if (target === undefined) throw new PeerError('RECORD_NOT_FOUND', 'no active pairing target')
  return target
}

/** Print one delegation run result as tab-separated fields plus the settled reply body.
 * @param result - run result from the target.
 */
function writeRunResult(result: Awaited<ReturnType<typeof runPeerDelegate>>): void {
  internals.stdout.write(`session\t${result.sessionId}\t${result.state}${result.endReason !== undefined ? `\t${result.endReason}` : ''}\n`)
  if (result.reply !== undefined) internals.stdout.write(`${result.reply}\n`)
}

/** Print one async submission receipt naming the settlement-read command.
 * @param config - runner configuration carrying the async flag.
 * @param result - the accepted turn's run result.
 */
function writeReceiptHint(config: Config, result: Awaited<ReturnType<typeof runPeerDelegate>>): void {
  if (config.async !== true) return
  internals.stdout.write(`receipt\t${result.sessionId}\t${result.messageId}\tread with: dsh peer result <instance-id> ${result.sessionId} ${result.messageId}\n`)
}

/** Bound one per-call transport timeout so long settlement budgets stay usable.
 * @param value - CLI-provided timeout in milliseconds.
 * @returns the per-call timeout.
 */
function boundCallTimeout(value: number): number {
  return Math.min(Math.max(value, 1_000), 120_000)
}

/** Derive the settlement-wait budget from the CLI timeout.
 * @param value - CLI-provided timeout in milliseconds.
 * @returns the delegation settlement budget.
 */
function settleBudget(value: number): number {
  return Math.min(value, 900_000)
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
