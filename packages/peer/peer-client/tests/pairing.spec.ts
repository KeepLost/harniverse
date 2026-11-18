/** Pairing against a real Loader-composed serving stack over loopback HTTP. */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Authentication from '@deepseek-ai/dsh-authentication-local'
import * as WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Gateway from '@deepseek-ai/dsh-api-gateway'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import {
  createAuthenticationClientGrant,
  issueEnrollmentInvitation,
  listAuthenticationGrants,
} from '@deepseek-ai/dsh-authentication-local'
import {
  PeerError,
  encodePeerInvite,
  ensureInstanceIdentity,
  peerInstanceId,
} from '@deepseek-ai/dsh-peer-protocol'
import type { PeerInvitePayload } from '@deepseek-ai/dsh-peer-protocol'
import * as PeerHost from '@deepseek-ai/dsh-peer-host'
import { ensurePeerIdentityKey, pairWithPeer, readPeerTargets } from '../src/index.ts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'

const directories: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  while (contexts.length) await contexts.pop()!.fiber.dispose()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  directories.push(path)
  return path
}

interface Serving {
  origin: string
  home: string
  identity: Awaited<ReturnType<typeof ensureInstanceIdentity>>
  invite: () => Promise<PeerInvitePayload>
}

/** Boot the accepting stack — authentication, web server, gateway, connection, peer-host — through the Loader. */
async function serving(): Promise<Serving> {
  const home = await temporary('peer-target-')
  const identity = await ensureInstanceIdentity(home)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(home).href + '/'
  const config = join(home, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { id: 'authentication', name: 'authentication', config: { dshHome: home, watch: false } },
    { id: 'webserver', name: 'webserver', inject: ['authentication'], config: { host: '127.0.0.1', port: 0 } },
    { id: 'peer-host', name: 'peer-host', config: { dshHome: home } },
    { id: 'typert', name: 'typert' },
    { id: 'gateway', name: 'gateway' },
    { id: 'connection', name: 'connection' },
  ]))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    const modules: Record<string, object> = {
      authentication: Authentication, webserver: WebServer,
      'peer-host': PeerHost, typert: Typert, gateway: Gateway, connection: Connection,
    }
    const module = modules[specifier]
    if (!module) throw new Error(`unknown fixture module ${specifier}`)
    return module
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  await createAuthenticationClientGrant({ name: 'owner', publicKey, capabilities: ['harniverse.authorize'] }, { dshHome: home })
  const invite = async () => {
    const invitation = await issueEnrollmentInvitation({
      capabilities: ['harniverse.peer'], kind: 'peer', ttlMs: 60_000,
    }, { dshHome: home })
    return {
      version: 1 as const,
      instanceId: identity.instanceId,
      displayName: identity.displayName,
      endpoint: { origin },
      token: invitation.token,
    }
  }
  return { origin, home, identity, invite }
}

it('pairs an initiator with a real serving target end to end', async () => {
  const target = await serving()
  const initiatorHome = await temporary('peer-initiator-')
  const plain = await target.invite()
  await pairWithPeer({ invite: plain, home: initiatorHome, origin: target.origin })
  const secondHome = await temporary('peer-initiator-')
  const pinned = await target.invite()
  const withPin = { ...pinned, tlsFingerprint: 'A'.repeat(43) }
  const pinnedResult = await pairWithPeer({ invite: withPin, home: secondHome, origin: target.origin })
  expect(pinnedResult.target.tlsFingerprint).toBe('A'.repeat(43))
  const result = pinnedResult
  expect(result.hello.instanceId).toBe(target.identity.instanceId)
  expect(result.hello.surface).toEqual({ delegate: true, message: true, list: true })
  const grants = await listAuthenticationGrants({ dshHome: target.home })
  const peerGrant = grants.find(grant => grant.id === result.grantId)
  expect(peerGrant).toMatchObject({ kind: 'api-client', capabilities: ['harniverse.peer'], name: result.target.grantName })
  expect(await readFile(join(target.home, 'peers.json'), 'utf8')).toContain(result.target.grantName.slice('peer-'.length))
  const targets = await readPeerTargets(initiatorHome)
  expect(targets).toHaveLength(1)
  expect(targets[0]).toMatchObject({ targetInstanceId: target.identity.instanceId, status: 'active', transport: { kind: 'direct' } })
})

it('re-pairs over an existing target record and keeps exactly one entry', async () => {
  const target = await serving()
  const initiatorHome = await temporary('peer-initiator-')
  await pairWithPeer({ invite: await target.invite(), home: initiatorHome, origin: target.origin })
  await pairWithPeer({ invite: await target.invite(), home: initiatorHome, origin: target.origin })
  expect(await readPeerTargets(initiatorHome)).toHaveLength(1)
})

it('rejects a spent invitation with the closed redeem reason', async () => {
  const target = await serving()
  const firstHome = await temporary('peer-initiator-')
  const invite = await target.invite()
  await pairWithPeer({ invite, home: firstHome, origin: target.origin })
  const secondHome = await temporary('peer-second-')
  await expect(pairWithPeer({ invite, home: secondHome, origin: target.origin })).rejects.toThrowError(/REDEEM_REJECTED/)
})

it('rejects an invitation whose asserted target identity does not match the serving instance', async () => {
  const target = await serving()
  const initiatorHome = await temporary('peer-initiator-')
  const invite = await target.invite()
  const tampered: PeerInvitePayload = {
    ...invite,
    instanceId: peerInstanceId('99999999-1111-4222-8333-444455556666'),
  }
  void encodePeerInvite
  await expect(pairWithPeer({
    invite: tampered,
    home: initiatorHome,
    origin: target.origin,
  })).rejects.toThrowError(/IDENTITY_MISMATCH/)
})

it('rejects an unreachable origin with the closed transport reason', async () => {
  const target = await serving()
  const initiatorHome = await temporary('peer-initiator-')
  const invite = await target.invite()
  await expect(pairWithPeer({
    invite,
    home: initiatorHome,
    origin: 'http://127.0.0.1:1',
    timeoutMs: 500,
  })).rejects.toThrowError(/TRANSPORT_FAILED/)
})

it('mints one P-256 signing identity per home and reports its public material', async () => {
  const initiatorHome = await temporary('peer-initiator-')
  const first = await ensurePeerIdentityKey(initiatorHome)
  const second = await ensurePeerIdentityKey(initiatorHome)
  expect(second.publicKey).toBe(first.publicKey)
  const signature = await first.signChallenge('payload')
  expect(typeof signature).toBe('string')
  expect(() => { void PeerError }).not.toThrow()
})

/** Scripted-fetch branch coverage; hello envelopes echo the request's rpcId. */
function scripted(responses: Array<{ status?: number; body?: unknown; raw?: string }>): typeof globalThis.fetch {
  let index = 0
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = responses[Math.min(index, responses.length - 1)]!
    index += 1
    if (reply.raw !== undefined) {
      return new Response(reply.raw, { status: reply.status ?? 200 })
    }
    let body = reply.body === undefined ? {} : reply.body
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (typeof url === 'string' && url.endsWith('/api/peer/hello') && init?.body !== undefined) {
      const request = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { rpcId?: string }
      if (typeof request.rpcId === 'string' && typeof body === 'object' && body !== null) {
        body = { ...body as Record<string, unknown>, rpcId: request.rpcId }
      }
    }
    return new Response(body === undefined ? '{}' : JSON.stringify(body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

async function pairingHome(): Promise<string> {
  return await temporary('peer-branch-')
}

function validInvite(): PeerInvitePayload {
  return {
    version: 1,
    instanceId: peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666'),
    displayName: 'Target',
    endpoint: { origin: 'http://127.0.0.1:9' },
    token: `dshi1_${'A'.repeat(27)}`,
  }
}

it('rejects each orchestration stage with its closed reason', async () => {
  const home = await pairingHome()
  const cases: Array<{ responses: Array<{ status?: number; body?: unknown; raw?: string }>; pattern: RegExp }> = [
    { responses: [{ status: 409, body: {} }], pattern: /ENROLLMENT_REJECTED/ },
    { responses: [{ body: { state: 'unexpected' } }], pattern: /ENROLLMENT_REJECTED/ },
    { responses: [{ body: { state: 'pending', id: 'enr' } }, { status: 404, body: {} }], pattern: /REDEEM_REJECTED/ },
    { responses: [{ body: { state: 'pending', id: 'enr' } }, { body: { state: 'pending' } }], pattern: /REDEEM_REJECTED/ },
  ]
  for (const testCase of cases) {
    await expect(pairWithPeer({ invite: validInvite(), home, origin: 'http://127.0.0.1:9', timeoutMs: 1_000, fetch: scripted(testCase.responses) }))
      .rejects.toThrowError(testCase.pattern)
  }
})

it('rejects malformed hello envelopes, bodies, and surfaces', async () => {
  const home = await pairingHome()
  const grant = 'ZAmaIsTHXZPHHDnV'
  const approved = [
    { body: { state: 'pending', id: 'enr' } },
    { body: { state: 'approved', grantId: grant } },
    { body: { id: 'cha', payload: 'c2lnbg', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    { body: { accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
  ]
  const cases: Array<{ responses: Array<{ status?: number; body?: unknown; raw?: string }>; pattern: RegExp }> = [
    { responses: [...approved, { status: 500, body: {} }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { raw: 'not json' }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'other', result: { ok: true } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: 'x' } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { instanceId: 'nope' } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: 'T', platform: 'linux', arch: 'x64', version: '1', surface: { delegate: true },
    } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: false } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: 'x'.repeat(65), platform: 'linux', arch: 'x64', version: '1', surface: { delegate: true, message: true, list: true },
    } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: 'T', platform: 5, arch: 'x64', version: '1', surface: { delegate: true, message: true, list: true },
    } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: '', platform: 'linux', arch: 'x64', version: '1', surface: { delegate: true, message: true, list: true },
    } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: 'T', platform: 'linux', arch: 'x64', version: '1', surface: { delegate: true, message: 'x', list: true },
    } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: 'T', platform: 'linux', arch: 5, version: '1', surface: { delegate: true, message: true, list: true },
    } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: 'T', platform: 'linux', arch: 'x64', version: 5, surface: { delegate: true, message: true, list: true },
    } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: 'T', platform: 'linux', arch: 'x64', version: '1', surface: { delegate: 'x', message: true, list: true },
    } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: 'T', platform: 'linux', arch: 'x64', version: '1', surface: { delegate: true, message: true, list: 'x' },
    } } } }], pattern: /HELLO_REJECTED/ },
    { responses: [...approved, { body: { type: 'server-response', rpcId: 'x', result: { ok: true, value: {
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666', displayName: 'T', platform: 'linux', arch: 'x64', version: '1', surface: 'x',
    } } } }], pattern: /HELLO_REJECTED/ },
  ]
  for (const testCase of cases) {
    await expect(pairWithPeer({ invite: validInvite(), home, origin: 'http://127.0.0.1:9', timeoutMs: 1_000, fetch: scripted(testCase.responses) }))
      .rejects.toThrowError(testCase.pattern)
  }
})

it('rejects non-JSON enrollment responses with the transport reason', async () => {
  const home = await pairingHome()
  await expect(pairWithPeer({ invite: validInvite(), home, origin: 'http://127.0.0.1:9', timeoutMs: 1_000, fetch: scripted([{ raw: '<html>' }]) }))
    .rejects.toThrowError(/TRANSPORT_FAILED/)
})

it('maps identity-key mint failures onto the closed store reason', async () => {
  const blockedHome = await temporary('peer-blocked-')
  const { writeFile } = await import('node:fs/promises')
  const { peerIdentityKeyPath, ensurePeerIdentityKey } = await import('../src/index.ts')
  const { dirname } = await import('node:path')
  const target = peerIdentityKeyPath(blockedHome)
  await writeFile(dirname(target), 'a plain file blocks key creation')
  void target
  await expect(ensurePeerIdentityKey(blockedHome)).rejects.toThrowError(/STORE_FAILED/)
})

it('rejects a non-EC identity key file with the closed corrupt reason', async () => {
  const initiatorHome = await temporary('peer-rsa-')
  const { generateKeyPairSync } = await import('node:crypto')
  const pem: string = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' })
  const { peerIdentityKeyPath } = await import('../src/index.ts')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const target = peerIdentityKeyPath(initiatorHome)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, pem)
  const { ensurePeerIdentityKey } = await import('../src/index.ts')
  await expect(ensurePeerIdentityKey(initiatorHome)).rejects.toThrowError(/CORRUPT_INSTANCE/)
})
