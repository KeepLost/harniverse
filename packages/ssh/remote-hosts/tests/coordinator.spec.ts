import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import { fixture, fixtureArchitecture, fixturePlatform, hostInput } from './fixture.ts'
import { RemoteHosts } from '../src/index.ts'
import type { RemoteHostView } from '../src/types.ts'
import { remoteHostId } from '../src/validation.ts'

it('Loader local-owner API persists secret refs, deploys, authenticates real HTTP, syncs, disconnects and reconnects', async () => {
  const f = await fixture()
  try {
    const schema = z.object({ apiKeyEnv: z.string().role('credential-ref'), baseURL: z.string() })
    f.ctx.settings.register(settingsNamespace('llm-deepseek'), schema, { base: { apiKeyEnv: 'MODEL_ONLY', baseURL: 'http://127.0.0.1:9000/v1' } })
    f.remoteCtx.settings.register(settingsNamespace('llm-deepseek'), schema)
    await f.ctx.credentials.set(credentialRef('MODEL_ONLY'), 'model-secret')
    await f.ctx.credentials.set(credentialRef('UNRELATED_SECRET'), 'never-transfer')
    const rpcId = 'local-owner-upsert'
    const response = await fetch(`http://127.0.0.1:${f.ctx.webServer.port}/api/remoteHosts/upsert`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId,
        method: 'remoteHosts/upsert', payload: { args: { input: { ...hostInput, dshHome: f.remote,
          secrets: { kind: 'password', password: 'ssh-secret' }, storeCredentials: true,
          reverseMappings: [{ localHost: '127.0.0.1', localPort: 9000, remoteOriginalOrigin: 'http://127.0.0.1:9000' }] } } } }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { ok: boolean; value: RemoteHostView } }
    expect(body.result, JSON.stringify(body)).toMatchObject({ ok: true })
    const host = body.result.value
    expect(host.authentication.kind).toBe('password')
    if (host.authentication.kind === 'password') expect(host.authentication.passwordRef).toMatch(/^DSH_REMOTE_HOST_/)
    const disk = await readFile(join(f.local, 'remote-hosts.json'), 'utf8')
    expect(disk).not.toContain('ssh-secret')
    expect(JSON.stringify(host)).not.toContain('ssh-secret')
    const config = (f.ctx.remoteHosts as unknown as { config: { startupTimeoutMs?: number; requestTimeoutMs?: number } }).config
    delete config.startupTimeoutMs
    delete config.requestTimeoutMs
    const firstConnect = f.ctx.remoteHosts.connect({ id: host.id })
    const secondConnect = f.ctx.remoteHosts.connect({ id: host.id })
    const [connected, coalesced] = await Promise.all([firstConnect, secondConnect])
    expect(coalesced).toEqual(connected)
    expect(f.observations.opens).toHaveLength(1)
    expect(connected.state).toBe('connected')
    expect(f.observations.starts).toBe(0)
    expect(f.observations.uploads).toBe(2)
    expect(f.observations.opens[0]?.auth).toEqual({ kind: 'password', password: 'ssh-secret' })
    await expect(f.ctx.remoteHosts.upsert({ ...hostInput, id: host.id })).rejects.toThrow('DISCONNECT_BEFORE_EDIT')
    await expect(f.ctx.remoteHosts.verify({ host: hostInput.host, port: hostInput.port, username: hostInput.username,
      secrets: { kind: 'password', password: 'one-use' } }))
      .resolves.toEqual({ fingerprint: hostInput.fingerprint, platform: fixturePlatform, architecture: fixtureArchitecture })
    await f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'ssh-secret' }, storeCredentials: true })
    expect(f.remoteCtx.settings.describe().find(row => row.ns === 'llm-deepseek')?.value).toEqual({
      apiKeyEnv: 'MODEL_ONLY', baseURL: 'http://127.0.0.1:30001/v1',
    })
    expect(f.remoteCtx.remoteRuntime.status().locked).toBe(false)
    const sessions = (f.ctx.remoteHosts as unknown as { sessions: Map<string, { transport?: unknown }> }).sessions
    const session = sessions.get(host.id)!
    const connectedTransport = session.transport
    session.transport = undefined
    await expect(f.ctx.remoteHosts.request(host.id, '/api/sessions/list')).rejects.toThrow('NOT_CONNECTED')
    await expect(f.ctx.remoteHosts.openWebSocket(host.id, '/api/events')).rejects.toThrow('NOT_CONNECTED')
    session.transport = connectedTransport
    const statusResponse = await f.ctx.remoteHosts.request(host.id, '/api/remoteRuntime/status', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'coordinator-status', method: 'remoteRuntime/status', payload: { args: {} } }),
    })
    expect(statusResponse.ok).toBe(true)
    f.ctx.remoteHosts.authentication(host.id)
    await expect(f.ctx.remoteHosts.request(host.id, '/api/remoteHosts/list')).rejects.toThrow('REQUEST_FAILED')
    await expect(f.ctx.remoteHosts.openWebSocket(host.id, '/api/../events')).rejects.toThrow('REQUEST_FAILED')
    expect(await f.remoteCtx.credentials.resolve(credentialRef('MODEL_ONLY'))).toMatchObject({ value: 'model-secret' })
    expect(await f.remoteCtx.credentials.resolve(credentialRef('UNRELATED_SECRET'))).toBeUndefined()
    expect(f.ctx.remoteHosts.reverseMappings(host.id)).toEqual([{ localHost: '127.0.0.1', localPort: 9000,
      remoteOriginalOrigin: 'http://127.0.0.1:9000', remotePort: 30001 }])
    const grants = f.observations.stdin.filter(input => input.includes('publicKey'))
    expect(grants).toHaveLength(1)
    expect(grants[0]).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(await f.ctx.remoteHosts.list())).not.toContain('localTunnelPort')
    await f.ctx.remoteHosts.disconnect(host.id)
    await expect(f.ctx.remoteHosts.request(host.id, '/api/sessions/list')).rejects.toThrow('NOT_CONNECTED')
    await expect(f.ctx.remoteHosts.openWebSocket(host.id, '/api/events')).rejects.toThrow('NOT_CONNECTED')
    expect(() => f.ctx.remoteHosts.authentication(host.id)).toThrow('NOT_CONNECTED')
    expect(() => f.ctx.remoteHosts.reverseMappings(host.id)).toThrow('NOT_CONNECTED')
    expect(f.remoteCtx.remoteRuntime.status().bootId).toBe(f.endpoint.bootId)
    expect(f.remoteCtx.remoteRuntime.status().locked).toBe(false)
    expect(f.observations.disposals).toBe(1)
    await f.ctx.remoteHosts.connect({ id: host.id })
    expect(f.observations.uploads).toBe(2)
    expect(f.remoteCtx.remoteRuntime.status().bootId).toBe(f.endpoint.bootId)
    await f.ctx.remoteHosts.disconnect(host.id)
    await writeFile(join(f.remote, 'server/endpoint.json'), JSON.stringify({ ...f.endpoint,
      bootId: 'ecaf46e5-b82a-40af-9b56-0a119053d7c8' }))
    await expect(f.ctx.remoteHosts.connect({ id: host.id })).rejects.toThrow('ENDPOINT_IDENTITY_MISMATCH')
    expect((await f.ctx.remoteHosts.list())[0]?.state).toBe('error')
    expect(f.observations.starts).toBe(0)
    await writeFile(join(f.remote, 'server/endpoint.json'), JSON.stringify(f.endpoint))
    await f.ctx.remoteHosts.remove(host.id)
    expect(await f.ctx.remoteHosts.list()).toEqual([])
    expect(f.remoteCtx.remoteRuntime.status().locked).toBe(false)
  } finally { await f.cleanup() }
}, 40_000)

it('denies observer mutations, sanitizes failed SSH, and never stores ephemeral credentials', async () => {
  const f = await fixture()
  try {
    const principal = { kind: 'grant' as const, grantId: authenticationGrantId('observer'), grantRevision: 1,
      capabilities: ['harniverse.observe'] as const, expiresAt: '2099-01-01T00:00:00.000Z' }
    expect(await f.ctx.typertGateway.invoke({ namespace: 'remoteHosts', method: 'list', args: {}, principal })).toEqual([])
    await expect(f.ctx.typertGateway.invoke({ namespace: 'remoteHosts', method: 'upsert', args: { input: hostInput }, principal }))
      .rejects.toMatchObject({ code: 'authorization-denied' })
    const host = await f.ctx.remoteHosts.upsert(hostInput)
    f.observations.pinFail = true
    await expect(f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'ephemeral' } }))
      .rejects.toThrow('remote-hosts: CONNECT_FAILED')
    const view = (await f.ctx.remoteHosts.list())[0]!
    expect(view.state).toBe('error')
    expect(view.authentication).toEqual({ kind: 'password' })
    expect(view.error).not.toContain('upstream')
    expect(f.observations.commands).toEqual([])
    expect(await readFile(join(f.local, 'remote-hosts.json'), 'utf8')).not.toContain('ephemeral')
    f.observations.pinFail = false
    f.observations.holdOpen = true
    const connecting = f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } })
    const rejection = expect(connecting).rejects.toThrow('CONNECT_FAILED')
    await expect.poll(() => f.observations.opens.length).toBe(2)
    await f.ctx.remoteHosts.disconnect(host.id)
    await rejection
    expect((await f.ctx.remoteHosts.list())[0]?.state).toBe('offline')
    expect(f.observations.commands).toEqual([])
  } finally { await f.cleanup() }
})

it('plugin disposal drains local connections while the authenticated remote runtime remains unlocked', async () => {
  const f = await fixture()
  try {
    const host = await f.ctx.remoteHosts.upsert({ ...hostInput, dshHome: f.remote })
    await f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } })
    await f.ctx.fiber.dispose()
    expect(f.controllers.every(controller => controller.signal.aborted)).toBe(true)
    expect(f.observations.disposals).toBe(1)
    expect(f.remoteCtx.remoteRuntime.status()).toMatchObject({ bootId: f.endpoint.bootId, locked: false })
  } finally { await f.cleanup() }
})

it('delivers a failed connectivity test as a client-parseable carrier error', async () => {
  const f = await fixture()
  try {
    f.observations.verifyFail = true
    const rpcId = 'client-parseable-verify'
    const response = await fetch(`http://127.0.0.1:${f.ctx.webServer.port}/api/remoteHosts/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'remoteHosts/verify',
        payload: { args: { input: { host: 'fixture.invalid', username: 'runner', secrets: { kind: 'password', password: 'one-use' } } } } }),
    })
    expect(response.status).toBe(200)
    const parsed = serverResponseSchema.parse(await response.json())
    expect(parsed.result).toMatchObject({ ok: false,
      error: { code: 'remote-host-failed', details: { reason: 'VERIFY_FAILED' } } })
  } finally { await f.cleanup() }
}, 30_000)

it('contains verify and connect transport failures and retries after a lost local SSH connection', async () => {
  const f = await fixture()
  try {
    f.observations.verifyFail = true
    await expect(f.ctx.remoteHosts.verify({ host: 'fixture.invalid', username: 'runner',
      secrets: { kind: 'password', password: 'one-use' } })).rejects.toThrow('VERIFY_FAILED')
    f.observations.verifyFail = false
    // A reachable target answering with an undeployable platform keeps its own diagnosis.
    f.observations.verifyOutput = 'SunOS\nsparc\n'
    await expect(f.ctx.remoteHosts.verify({ host: 'fixture.invalid', username: 'runner',
      secrets: { kind: 'password', password: 'one-use' } })).rejects.toThrow('UNSUPPORTED_REMOTE_PLATFORM')
    f.observations.verifyOutput = undefined
    const host = await f.ctx.remoteHosts.upsert({ ...hostInput, dshHome: f.remote,
      reverseMappings: [{ localHost: '127.0.0.1', localPort: 9000, remoteOriginalOrigin: 'http://127.0.0.1:9000' }] })
    f.observations.forwardFail = true
    await expect(f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } }))
      .rejects.toThrow('CONNECT_FAILED')
    expect((await f.ctx.remoteHosts.list())[0]?.state).toBe('error')
    f.observations.forwardFail = false
    f.observations.reverseFail = true
    await expect(f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } }))
      .rejects.toThrow('CONNECT_FAILED')
    f.observations.reverseFail = false
    await f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } })
    f.controllers[2]!.abort()
    expect((await f.ctx.remoteHosts.list())[0]?.error).toBe('remote-hosts: CONNECTION_LOST')
    await f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } })
    expect(f.observations.opens).toHaveLength(4)
    await f.ctx.remoteHosts.disconnect(host.id)
    expect((await f.ctx.remoteHosts.list())[0]?.state).toBe('offline')
  } finally { await f.cleanup() }
}, 30_000)

it('starts a missing remote runtime and rejects an untrusted TLS endpoint', async () => {
  const f = await fixture()
  try {
    const host = await f.ctx.remoteHosts.upsert({ ...hostInput, dshHome: f.remote })
    await rm(join(f.remote, 'server/endpoint.json'))
    f.observations.restartOnStart = true
    f.observations.discoveryMissesAfterStart = 1
    f.observations.failedForwards = 1
    await f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } })
    expect(f.observations.starts).toBe(1)
    await f.ctx.remoteHosts.disconnect(host.id)
    f.observations.deadProcessProbes = 2
    await writeFile(join(f.remote, 'server/endpoint.json'), JSON.stringify({ ...f.endpoint, pid: process.pid + 100000 }))
    await f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } })
    expect(f.observations.starts).toBe(2)
    await f.ctx.remoteHosts.disconnect(host.id)
    await rm(join(f.remote, 'server/endpoint.json'))
    f.observations.endpointMismatchOnStart = true
    await expect(f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } }))
      .rejects.toThrow('ENDPOINT_IDENTITY_MISMATCH')
    expect(f.observations.starts).toBe(3)
    await writeFile(join(f.remote, 'server/endpoint.json'), JSON.stringify({ ...f.endpoint, protocol: 'https:' }))
    await expect(f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } }))
      .rejects.toThrow('UNSUPPORTED_ENDPOINT_TLS')
  } finally { await f.cleanup() }
}, 30_000)

it('validates public management inputs and stored credential mode mismatches', async () => {
  const f = await fixture()
  try {
    await expect(f.ctx.remoteHosts.verify({ host: '', username: 'runner', secrets: { kind: 'password', password: 'x' } })).rejects.toThrow('INVALID_INPUT')
    // A key secret carries exactly one of inline material or an absolute host-local path.
    await expect(f.ctx.remoteHosts.verify({ host: hostInput.host, username: 'runner',
      secrets: { kind: 'key', privateKey: 'inline', privateKeyPath: '/root/.ssh/id_ed25519' } as never })).rejects.toThrow('INVALID_INPUT')
    await expect(f.ctx.remoteHosts.verify({ host: hostInput.host, username: 'runner', secrets: { kind: 'key' } as never }))
      .rejects.toThrow('INVALID_INPUT')
    await expect(f.ctx.remoteHosts.verify({ host: hostInput.host, username: 'runner',
      secrets: { kind: 'key', privateKeyPath: 'relative/id_ed25519' } })).rejects.toThrow('INVALID_INPUT')
    // A UNC path is absolute for a Windows host; this Linux host just cannot read it.
    await expect(f.ctx.remoteHosts.verify({ host: hostInput.host, username: 'runner',
      secrets: { kind: 'key', privateKeyPath: '\\\\server\\share\\id_ed25519' } })).rejects.toThrow('KEY_FILE_READ_FAILED')
    await expect(f.ctx.remoteHosts.upsert({ ...hostInput, secrets: { kind: 'password', password: 'ephemeral' } }))
      .rejects.toThrow('EPHEMERAL_SECRETS_REQUIRE_CONNECT')
    const host = await f.ctx.remoteHosts.upsert(hostInput)
    await expect(f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'key', privateKey: 'private' } }))
      .rejects.toThrow('AUTH_KIND_MISMATCH')
    await expect(f.ctx.remoteHosts.disconnect(remoteHostId('22222222-2222-4222-8222-222222222222')))
      .rejects.toThrow('HOST_NOT_FOUND')
    await expect(f.ctx.remoteHosts.remove(remoteHostId('33333333-3333-4333-8333-333333333333')))
      .rejects.toThrow('HOST_NOT_FOUND')
    const states = (f.ctx.remoteHosts as unknown as { states: Map<string, unknown> }).states
    states.delete(host.id)
    expect((await f.ctx.remoteHosts.list())[0]?.state).toBe('offline')
    const registry = (f.ctx.remoteHosts as unknown as { registry: { remove(id: string): Promise<void> } }).registry
    const remove = registry.remove.bind(registry)
    registry.remove = async () => { throw new Error('disk write failed') }
    await expect(f.ctx.remoteHosts.remove(host.id)).rejects.toThrow('OPERATION_FAILED')
    registry.remove = remove
  } finally { await f.cleanup() }
})

it('aborts a pending SSH attempt during plugin disposal', async () => {
  const f = await fixture()
  try {
    const host = await f.ctx.remoteHosts.upsert({ ...hostInput, dshHome: f.remote })
    f.observations.holdOpen = true
    const connecting = f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } })
    const rejected = expect(connecting).rejects.toThrow('CONNECT_FAILED')
    await expect.poll(() => f.observations.opens.length).toBe(1)
    await f.ctx.fiber.dispose()
    await rejected
    expect(f.controllers.every(controller => controller.signal.aborted)).toBe(true)
  } finally { await f.cleanup() }
}, 30_000)

it('rejects endpoint discovery transport failures without exposing remote stderr', async () => {
  const f = await fixture()
  try {
    const host = await f.ctx.remoteHosts.upsert({ ...hostInput, dshHome: f.remote })
    f.observations.discoveryFail = true
    await expect(f.ctx.remoteHosts.connect({ id: host.id, secrets: { kind: 'password', password: 'one-use' } }))
      .rejects.toThrow('ENDPOINT_READ_FAILED')
    expect((await f.ctx.remoteHosts.list())[0]?.error).toBe('remote-hosts: ENDPOINT_READ_FAILED')
  } finally { await f.cleanup() }
}, 30_000)

it('serves path-based key logins end to end: the host reads the file at use time', async () => {
  const f = await fixture()
  try {
    const keyPath = join(f.local, 'id_path_ed25519')
    await writeFile(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\npath-fixture\n')
    await expect(f.ctx.remoteHosts.verify({ host: hostInput.host, port: hostInput.port, username: hostInput.username,
      secrets: { kind: 'key', privateKeyPath: keyPath, passphrase: 'phrase' } }))
      .resolves.toEqual({ fingerprint: hostInput.fingerprint, platform: fixturePlatform, architecture: fixtureArchitecture })
    // The SSH transport sees the file's material, never the path.
    expect(f.observations.verifications.at(-1)?.auth).toEqual({
      kind: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\npath-fixture\n', passphrase: 'phrase' })
    // An unreadable path is the closed read failure with its code preserved.
    await expect(f.ctx.remoteHosts.verify({ host: hostInput.host, port: hostInput.port, username: hostInput.username,
      secrets: { kind: 'key', privateKeyPath: join(f.local, 'missing') } })).rejects.toThrow('KEY_FILE_READ_FAILED')

    const host = await f.ctx.remoteHosts.upsert({ ...hostInput, dshHome: f.remote, authentication: { kind: 'key' },
      secrets: { kind: 'key', privateKeyPath: keyPath, passphrase: 'phrase' }, storeCredentials: true })
    // The record keeps the host-local path; no key material is stored anywhere.
    expect(host.authentication.kind).toBe('key')
    expect((host.authentication as { keyPath?: string }).keyPath).toBe(keyPath)
    expect(typeof (host.authentication as { passphraseRef?: string }).passphraseRef).toBe('string')
    const disk = await readFile(join(f.local, 'remote-hosts.json'), 'utf8')
    expect(disk).not.toContain('path-fixture')
    // Connecting with no submitted secrets reads the file on this host.
    const connected = await f.ctx.remoteHosts.connect({ id: host.id })
    expect(connected.state).toBe('connected')
    expect(f.observations.opens.at(-1)?.auth).toEqual({
      kind: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\npath-fixture\n', passphrase: 'phrase' })
  } finally { await f.cleanup() }
}, 30_000)

it('serves the native key-file chooser and reports its composition faithfully', async () => {
  const f = await fixture()
  try {
    const key = join(f.local, 'id_fixture')
    await writeFile(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n')
    f.observations.pickAnswer = key
    await expect(f.ctx.remoteHosts.pickKeyFile()).resolves.toEqual({ path: key })
    // The chooser is seeded at the operator's home ~/.ssh when it exists.
    expect(f.observations.pickRequests.at(-1)?.title).toBe('Select SSH Private Key')
    expect(f.observations.pickRequests.at(-1)?.defaultDirectory).toBe(join(homedir(), '.ssh'))

    f.observations.pickAnswer = null
    await expect(f.ctx.remoteHosts.pickKeyFile()).resolves.toEqual({})

    f.observations.pickAnswer = undefined
    await expect(f.ctx.remoteHosts.pickKeyFile()).rejects.toThrow('KEY_PICKER_FAILED')

    f.observations.pickerKind = 'browse'
    await expect(f.ctx.remoteHosts.pickKeyFile()).rejects.toThrow('KEY_PICKER_UNAVAILABLE')
  } finally { await f.cleanup() }
}, 30_000)

it('reports the composed key-file interaction for affordance routing', async () => {
  const f = await fixture()
  try {
    await expect(f.ctx.remoteHosts.keyFilePicker()).resolves.toEqual({ kind: 'native' })
    // A browse composition serves in-app directory browsing, not an OS chooser.
    f.observations.pickerKind = 'browse'
    await expect(f.ctx.remoteHosts.keyFilePicker()).resolves.toEqual({ kind: 'browse' })
  } finally { await f.cleanup() }
}, 30_000)

it('treats an absent or foreign picker as no picking interaction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-hosts-nopicker-'))
  const ctx = new Context()
  try {
    const service = new RemoteHosts(ctx, { dshHome: home, artifactsRoot: home })
    await expect(service.keyFilePicker()).resolves.toEqual({ kind: 'absent' })
    ctx.provide('directoryPicker', { capability: () => ({ kind: 'foreign' }) } as never)
    await expect(service.keyFilePicker()).resolves.toEqual({ kind: 'absent' })
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
