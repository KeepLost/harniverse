import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import LocalAuthentication from '@deepseek-ai/dsh-authentication-local'
import { afterEach, describe, expect, it } from 'vitest'
import DesktopWebServer, { DesktopAdmission } from '../src/admission.ts'
import DesktopControl from '../src/control.ts'
import DesktopDirectoryPicker, { CallbackDesktopShell } from '../src/directory-picker.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let settle: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, resolve: (value) => { settle?.(value) } }
}
function key() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    sign: (payload: string) => sign('sha256', Buffer.from(payload), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }
}

async function composition(existingHome?: string) {
  const home = existingHome ?? await mkdtemp(join(tmpdir(), 'desktop-loader-'))
  if (existingHome === undefined) cleanups.push(() => rm(home, { recursive: true, force: true }))
  const config = join(home, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { id: 'admission', name: 'cordis:admission' },
    { id: 'auth', name: 'cordis:auth', config: { dshHome: home, watch: false } },
    { id: 'web', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { id: 'picker', name: 'cordis:picker' },
    { id: 'observation', name: 'cordis:observation' },
    { id: 'control', name: 'cordis:control', config: { home } },
    { id: 'http', name: 'cordis:http' },
  ]))
  const state = { running: false, terminal: false, schedule: false }
  const teardown = deferred<undefined>()
  const ctx = await boot('desktop-loader-test', config, undefined, async (ctx) => {
    await ctx.plugin(CallbackDesktopShell, async () => '/selected-by-shell')
    Object.assign(ctx.loader.builtins, {
      admission: DesktopAdmission, auth: LocalAuthentication, web: DesktopWebServer,
      picker: DesktopDirectoryPicker, control: DesktopControl,
      observation: { name: 'observation', apply(ctx: Context) {
        // Only runtime projections are deterministic fixtures; auth, HTTP, Loader and Providers are real.
        ctx.provide('sessions', { list: () => [{ id: 'one' }] })
        ctx.provide('agents', { list: () => [], close: async () => false })
        ctx.provide('apiProxy', { sessions: { status: async () => ({ result: { ok: true, value: {
          running: state.running, closing: false, queue: [], jobs: [], interactions: [],
        } } }) } })
        ctx.provide('terminalController', { list: () => state.terminal ? [{ state: 'running' }] : [] })
        ctx.provide('scheduler', { listAll: () => state.schedule ? [{ status: 'active' }] : [] })
        ctx.effect(() => () => teardown.promise)
      } },
      http: { name: 'http', inject: ['authentication', 'webServer'], apply(ctx: Context) {
        ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/protected', handler: async (request, response) => {
          const auth = await ctx.authentication.authenticate({ channel: 'http-api', peerAddress: '127.0.0.1',
            ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }) })
          response.writeHead(auth.kind === 'accepted' ? 200 : 401)
          response.end(auth.kind)
        } }))
      } },
    })
  })
  cleanups.push(async () => { teardown.resolve(undefined); await ctx.fiber.dispose() })
  return { ctx, state, teardown, home, url: `http://127.0.0.1:${String(ctx.webServer.port)}` }
}

describe('Loader desktop composition', () => {
  it('restores only its persisted exact Grant, and never restores authority after revocation', async () => {
    const first = await composition()
    const shell = key()
    const enrolled = await first.ctx.desktopControl.enroll(shell.publicKey)
    first.teardown.resolve(undefined)
    await first.ctx.fiber.dispose()
    const second = await composition(first.home)
    expect(await second.ctx.desktopControl.activity()).toEqual({ status: 'idle', sessions: 0, tasks: 0 })
    expect((await second.ctx.desktopControl.enroll(shell.publicKey)).grant.id).toBe(enrolled.grant.id)
    await second.ctx.authentication.revokeGrant(enrolled.grant.id)
    await expect(second.ctx.desktopControl.enroll(shell.publicKey)).rejects.toThrow(/revoked|unavailable/)
    await expect(second.ctx.desktopControl.enroll(key().publicKey)).rejects.toThrow('different device')
    expect(await second.ctx.desktopControl.activity()).toEqual({ status: 'unknown' })
  })
  it('approves only the shell-created enrollment and retains authenticated HTTP admission', async () => {
    const { ctx, url } = await composition()
    expect((await fetch(`${url}/protected`)).status).toBe(401)
    expect(await ctx.desktopControl.activity()).toEqual({ status: 'unknown' })
    const stranger = await ctx.authentication.requestEnrollment({ name: 'Unrelated browser', kind: 'device', publicKey: key().publicKey })
    if (stranger.kind !== 'accepted') throw new Error('expected pending request')
    const shell = key()
    const enrollment = await ctx.desktopControl.enroll(shell.publicKey)
    expect(enrollment.enrollmentId).not.toBe(stranger.value.id)
    expect(await ctx.authentication.enrollmentStatus(stranger.value.id)).toMatchObject({ state: 'pending' })
    const challenge = await ctx.authentication.createChallenge(enrollment.grant.id, 'access-token')
    if (challenge.kind !== 'accepted') throw new Error('expected challenge')
    const token = await ctx.authentication.exchangeAccessToken({
      challengeId: challenge.value.id, signature: shell.sign(challenge.value.payload),
    })
    if (token.kind !== 'accepted') throw new Error('expected token')
    expect((await fetch(`${url}/protected`, { headers: { authorization: `Bearer ${token.value.value}` } })).status).toBe(200)
    const picker = ctx.directoryPicker.capability()
    if (picker.kind !== 'native') throw new Error('expected native picker')
    expect(await picker.pick(new AbortController().signal)).toBe('/selected-by-shell')
    await ctx.authentication.revokeGrant(enrollment.grant.id)
    expect(await ctx.desktopControl.activity()).toEqual({ status: 'unknown' })
    expect(await ctx.desktopControl.updateTasks('lock')).toEqual({ status: 'unknown' })
    await expect(ctx.desktopControl.enroll(key().publicKey)).rejects.toThrow('different device')
    expect((await fetch(`${url}/protected`, { headers: { authorization: `Bearer ${token.value.value}` } })).status).toBe(401)
  })

  it('combines activity sources, gates all routes for update, and awaits actual fiber cleanup', async () => {
    const { ctx, url, state, teardown } = await composition()
    await ctx.desktopControl.enroll(key().publicKey)
    expect(await ctx.desktopControl.activity()).toEqual({ status: 'idle', sessions: 0, tasks: 0 })
    ctx.emit('authentication/unavailable')
    expect(await ctx.desktopControl.activity()).toEqual({ status: 'unknown' })
    ctx.emit('authentication/available')
    state.running = true; state.terminal = true; state.schedule = true
    expect(await ctx.desktopControl.activity()).toEqual({ status: 'active', sessions: 1, tasks: 2 })
    expect(await ctx.desktopControl.updateTasks('lock')).toEqual({ status: 'active', sessions: 1, tasks: 2 })
    expect((await fetch(`${url}/protected`)).status).toBe(401)
    state.running = false; state.terminal = false; state.schedule = false
    expect(await ctx.desktopControl.updateTasks('lock')).toEqual({ status: 'idle', sessions: 0, tasks: 0 })
    expect((await fetch(`${url}/protected`, { method: 'POST' })).status).toBe(503)
    await ctx.desktopControl.updateTasks('unlock')
    expect((await fetch(`${url}/protected`)).status).toBe(401)
    ctx.desktopAdmission.stop()
    let complete = false
    const disposal = ctx.fiber.dispose().then(() => { complete = true })
    await Promise.resolve()
    expect(complete).toBe(false)
    teardown.resolve(undefined)
    await disposal
    expect(ctx.get('desktopControl')).toBeUndefined()
    await expect(fetch(`${url}/protected`)).rejects.toThrow()
  })
})
