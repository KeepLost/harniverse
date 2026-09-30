import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import EncryptedCredentialProvider from '@deepseek-ai/dsh-credentials-encrypted'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import ModelPolicy from '@deepseek-ai/dsh-model-policy'
import SessionStore from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import RemoteRuntime from '../src/index.ts'
import type { RuntimeEndpoint } from '../src/types.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load() { return Promise.resolve({}) }
  protected persist() { return Promise.resolve() }
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function mount(home?: string, deployment: { host?: string; mode?: string; encrypted?: boolean; ownerlessExitMs?: number } = {}) {
  if (home === undefined) {
    home = await mkdtemp(join(tmpdir(), 'remote-runtime-'))
    const dir = home
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('webServer', { host: deployment.host ?? '127.0.0.1', port: 42001, protocol: 'http:' })
  ctx.provide('authentication', { mode: deployment.mode ?? 'authenticated' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemorySettings)
  if (deployment.encrypted === false) ctx.provide('credentials', { status: () => ({ locked: true }) })
  else await ctx.plugin(EncryptedCredentialProvider, { dshHome: home })
  const model = ctx.settings.register(settingsNamespace('llm-deepseek'), z.object({
    model: z.string().default('default'), credentialRef: z.string(),
  }))
  const search = ctx.settings.register(settingsNamespace('web-search-kagi'), z.object({
    enabled: z.boolean().default(false),
  }))
  const theme = ctx.settings.register(settingsNamespace('ui-theme'), z.object({ dark: z.boolean().default(false) }))
  const fiber = ctx.plugin(RemoteRuntime, { dshHome: home,
    ...(deployment.ownerlessExitMs === undefined ? {} : { ownerlessExitMs: deployment.ownerlessExitMs }) })
  await fiber
  return { ctx, home, fiber, model, search, theme, runtime: ctx.remoteRuntime }
}

it('rejects locked admission, replaces credentials exactly, and restarts locked', async () => {
  const first = await mount()
  const { runtime, ctx, home } = first
  expect(runtime.status()).toMatchObject({ locked: true, platform: process.platform, arch: process.arch })
  expect(() => { runtime.assertUnlocked() }).toThrow(/locked/)
  expect(() => { ctx.agents.assertAdmission({} as never) }).toThrow(/locked/)
  await expect(runtime.replaceCredentials({ KEY: 'value' })).rejects.toThrow(/locked/)
  const key = randomBytes(32).toString('base64url')
  await runtime.unlock(key)
  await runtime.replaceCredentials({ KEEP: 'secret', REMOVE: 'old' })
  await runtime.replaceCredentials({ KEEP: 'new' })
  expect(await ctx.credentials.resolve(credentialRef('REMOVE'))).toBeUndefined()
  expect(await ctx.credentials.resolve(credentialRef('KEEP'))).toEqual({ value: 'new', source: 'encrypted' })
  expect(() => { ctx.agents.assertAdmission({} as never) }).not.toThrow()
  const bootId = runtime.status().bootId
  await ctx.fiber.dispose()
  const next = await mount(home)
  expect(next.runtime.status().bootId).not.toBe(bootId)
  expect(next.runtime.status().locked).toBe(true)
  await expect(next.runtime.unlock(randomBytes(32).toString('base64url'))).rejects.toThrow()
  await next.runtime.unlock(key)
  expect(await next.ctx.credentials.resolve(credentialRef('KEEP'))).toEqual({ value: 'new', source: 'encrypted' })
})

it('replaces model/search sections including omitted sections without changing unrelated settings', async () => {
  const { runtime, model, search, theme } = await mount()
  await runtime.unlock(randomBytes(32).toString('base64url'))
  await theme.replace({ dark: true })
  await runtime.syncSettings({ 'llm-deepseek': { model: 'local', credentialRef: 'KEEP' }, 'web-search-kagi': { enabled: true } })
  expect(model.get()).toEqual({ model: 'local', credentialRef: 'KEEP' })
  expect(search.get().enabled).toBe(true)
  await runtime.syncSettings({ 'llm-deepseek': { model: 'next' } })
  expect(model.get()).toEqual({ model: 'next' })
  expect(search.get().enabled).toBe(false)
  expect(theme.get().dark).toBe(true)
  await expect(runtime.syncSettings({ 'ui-theme': { dark: false } })).rejects.toThrow(/namespace/)
  await expect(runtime.syncSettings({ 'llm-deepseek': { model: 42 } })).rejects.toThrow()
  expect(model.get().model).toBe('next')
})

it('publishes an owner-only endpoint and removes only its own descriptor on disposal', async () => {
  const { runtime, ctx, home } = await mount()
  const path = join(home, 'server', 'endpoint.json')
  const descriptor = JSON.parse(await readFile(path, 'utf8')) as RuntimeEndpoint
  expect(descriptor).toEqual({ version: 1, host: '127.0.0.1', port: 42001, protocol: 'http:', pid: process.pid, bootId: runtime.status().bootId })
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(home, 'server'))).mode & 0o777).toBe(0o700)
  }
  await writeFile(path, JSON.stringify({ ...descriptor, bootId: 'successor' }))
  await ctx.fiber.dispose()
  expect((JSON.parse(await readFile(path, 'utf8')) as RuntimeEndpoint).bootId).toBe('successor')
  const next = await mount(home)
  await next.ctx.fiber.dispose()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('withdraws the admission policy and declares capability metadata on every Remote', async () => {
  const { ctx, runtime, fiber } = await mount()
  expect(remoteMethods(runtime).map(({ method, requiredCapability }) => [method, requiredCapability])).toEqual([
    ['status', 'harniverse.observe'], ['unlock', 'harniverse.administer'],
    ['replaceCredentials', 'harniverse.administer'], ['syncSettings', 'harniverse.administer'],
  ])
  await fiber.dispose()
  expect(() => { ctx.agents.assertAdmission({} as never) }).not.toThrow()
})

it('rejects status access after the runtime fiber has been disposed', async () => {
  const { runtime, fiber } = await mount()
  await fiber.dispose()
  expect(() => runtime.status()).toThrow(/disposed/)
})

it('refuses non-loopback, bypass, and structurally similar credential providers', async () => {
  await expect(mount(undefined, { host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/)
  await expect(mount(undefined, { mode: 'bypass' })).rejects.toThrow(/authentication/)
  await expect(mount(undefined, { encrypted: false })).rejects.toThrow(/EncryptedCredentialProvider/)
})

it('rejects malformed snapshots without resetting configured sections', async () => {
  const { runtime, model } = await mount()
  await runtime.unlock(randomBytes(32).toString('base64url'))
  await runtime.syncSettings({ 'llm-deepseek': { model: 'keep' } })
  for (const value of [null, [], new Date(), { 'llm-deepseek': [] }]) {
    await expect(runtime.syncSettings(value as never)).rejects.toThrow(/snapshot|namespace/)
    expect(model.get().model).toBe('keep')
  }
})

it('synchronizes the real model-policy namespace through its owning schema', async () => {
  const { ctx, runtime } = await mount()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ModelPolicy)
  await runtime.unlock(randomBytes(32).toString('base64url'))
  await runtime.syncSettings({
    'model-routes': { routes: { local: { targets: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] } } },
  })
  expect(ctx.settings.get(settingsNamespace('model-routes'))).toEqual({
    routes: { local: { targets: [{ provider: 'deepseek-official', model: 'deepseek-chat' }] } },
  })
  await expect(runtime.syncSettings({ 'model-routes': { routes: { invalid: { targets: [{ model: 42 }] } } } })).rejects.toThrow()
  await runtime.syncSettings({ 'model-routes': { routes: {} } })
  expect(ctx.settings.get(settingsNamespace('model-routes'))).toEqual({ routes: {} })
})

it('signals an ownerless runtime once per starvation episode and re-arms on owner contact', async () => {
  const { ctx, runtime } = await mount(undefined, { ownerlessExitMs: 250 })
  let episodes = 0
  ctx.on('remote-runtime/ownerless', () => { episodes++ })
  await new Promise(resolve => setTimeout(resolve, 600))
  expect(episodes).toBe(1)
  // A returning owner clears the episode flag; fresh starvation signals again.
  runtime.status()
  await new Promise(resolve => setTimeout(resolve, 120))
  expect(episodes).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(episodes).toBe(2)
}, 10_000)

it('stays owned while owner contact keeps arriving within the exit window', async () => {
  const { ctx, runtime } = await mount(undefined, { ownerlessExitMs: 250 })
  let episodes = 0
  ctx.on('remote-runtime/ownerless', () => { episodes++ })
  for (let index = 0; index < 4; index++) {
    await new Promise(resolve => setTimeout(resolve, 150))
    runtime.status()
  }
  expect(episodes).toBe(0)
}, 10_000)

it('rejects an ownerless exit window outside the safe range', async () => {
  await expect(mount(undefined, { ownerlessExitMs: 100 })).rejects.toThrow(/ownerlessExitMs/)
})
