import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Agents from '@deepseek-ai/dsh-agent'
import * as Authentication from '@deepseek-ai/dsh-authentication-local'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import * as Credentials from '@deepseek-ai/dsh-credentials-encrypted'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as Settings from '@deepseek-ai/dsh-settings-file'
import * as WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Gateway from '@deepseek-ai/dsh-api-gateway'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { randomBytes } from 'node:crypto'
import { get } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import * as Runtime from '../src/index.ts'
import type { RuntimeEndpoint } from '../src/types.ts'

it('Loader boots locked, enforces Remote capabilities, and keeps unlock across a disconnected caller', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-loader-'))
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(home).href + '/'
    const modules: Record<string, object> = {
      agents: Agents, authentication: Authentication, credentials: Credentials,
      settings: Settings, webserver: WebServer, runtime: Runtime, gateway: Gateway, typert: Typert, connection: Connection,
    }
    const rows = [
      { id: 'agents', name: 'agents' },
      { id: 'settings', name: 'settings', config: { dshHome: home, watch: false } },
      { id: 'authentication', name: 'authentication', config: { dshHome: home, watch: false } },
      { id: 'credentials', name: 'credentials', config: { dshHome: home } },
      { id: 'webserver', name: 'webserver', inject: ['authentication'], config: { host: '127.0.0.1', port: 0 } },
      { id: 'runtime', name: 'runtime', config: { dshHome: home } },
      { id: 'typert', name: 'typert' },
      { id: 'gateway', name: 'gateway' },
      { id: 'connection', name: 'connection' },
    ]
    const config = join(home, 'cordis.yml')
    await writeFile(config, JSON.stringify(rows)) // JSON is also a YAML entry list.
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules[specifier]
        if (module === undefined) throw new Error(`unexpected fixture module ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    const endpoint = JSON.parse(await readFile(join(home, 'server', 'endpoint.json'), 'utf8')) as RuntimeEndpoint
    expect(endpoint.port).toBeGreaterThan(0)
    expect(endpoint.port).toBe(ctx.webServer.port)
    expect(ctx.remoteRuntime.status().locked).toBe(true)
    expect(await ctx.authentication.status()).toEqual({ mode: 'authenticated', sealed: true })
    const anonymous = await fetch(`http://127.0.0.1:${endpoint.port}/api/remoteRuntime/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(anonymous.status).toBe(401)
    expect(await anonymous.text()).toBe('unauthorized')
    const principal = {
      kind: 'grant' as const, grantId: authenticationGrantId('observer'), grantRevision: 1,
      capabilities: ['harniverse.observe'] as const, expiresAt: '2099-01-01T00:00:00.000Z',
    }
    const call = (method: string, args: Record<string, unknown>, administer = false) => ctx.typertGateway.invoke({
      namespace: 'remoteRuntime', method, args,
      principal: administer ? { ...principal, capabilities: ['harniverse.observe', 'harniverse.administer'] } : principal,
    })
    expect(await call('status', {})).toMatchObject({ locked: true })
    const key = randomBytes(32).toString('base64url')
    await expect(call('unlock', { key })).rejects.toMatchObject({ code: 'authorization-denied' })
    expect(ctx.remoteRuntime.status().locked).toBe(true)
    await call('unlock', { key }, true)
    await call('replaceCredentials', { snapshot: { MODEL_KEY: 'runtime-secret' } }, true)
    const httpStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`http://127.0.0.1:${endpoint.port}/auth/status`, { agent: false }, (response) => {
        response.resume()
        response.once('close', () => { resolve(response.statusCode) })
      }).once('error', reject)
    })
    expect(httpStatus).toBe(200)
    expect(await ctx.credentials.resolve(credentialRef('MODEL_KEY'))).toEqual({ value: 'runtime-secret', source: 'encrypted' })
    expect(await readFile(join(home, '.credentials.encrypted.json'), 'utf8')).not.toContain('runtime-secret')
    expect(() => { ctx.agents.assertAdmission({} as never) }).not.toThrow()
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
