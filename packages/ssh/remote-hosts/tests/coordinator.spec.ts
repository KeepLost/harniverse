import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import { fixture, hostInput } from './fixture.ts'
import type { RemoteHostView } from '../src/types.ts'

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
    const firstConnect = f.ctx.remoteHosts.connect({ id: host.id })
    const secondConnect = f.ctx.remoteHosts.connect({ id: host.id })
    const [connected, coalesced] = await Promise.all([firstConnect, secondConnect])
    expect(coalesced).toEqual(connected)
    expect(f.observations.opens).toHaveLength(1)
    expect(connected.state).toBe('connected')
    expect(f.observations.starts).toBe(0)
    expect(f.observations.uploads).toBe(2)
    expect(f.observations.opens[0]?.auth).toEqual({ kind: 'password', password: 'ssh-secret' })
    expect(f.remoteCtx.settings.describe().find(row => row.ns === 'llm-deepseek')?.value).toEqual({
      apiKeyEnv: 'MODEL_ONLY', baseURL: 'http://127.0.0.1:30001/v1',
    })
    expect(f.remoteCtx.remoteRuntime.status().locked).toBe(false)
    expect(await f.remoteCtx.credentials.resolve(credentialRef('MODEL_ONLY'))).toMatchObject({ value: 'model-secret' })
    expect(await f.remoteCtx.credentials.resolve(credentialRef('UNRELATED_SECRET'))).toBeUndefined()
    expect(f.ctx.remoteHosts.reverseMappings(host.id)).toEqual([{ localHost: '127.0.0.1', localPort: 9000,
      remoteOriginalOrigin: 'http://127.0.0.1:9000', remotePort: 30001 }])
    const grants = f.observations.stdin.filter(input => input.includes('publicKey'))
    expect(grants).toHaveLength(1)
    expect(grants[0]).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(await f.ctx.remoteHosts.list())).not.toContain('localTunnelPort')
    await f.ctx.remoteHosts.disconnect(host.id)
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
