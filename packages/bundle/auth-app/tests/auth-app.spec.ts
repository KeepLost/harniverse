/** Authentication management through the real startup/runner Loader composition. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals as cmdlineInternals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createEnrollmentRequest } from '@deepseek-ai/dsh-authentication-local'
import { afterEach, describe, expect, it } from 'vitest'
import { apply as applyRunner, internals as runnerInternals } from '../src/index.ts'
import { apply as applyStartup, AUTH_STARTUP_SERVICE } from '../src/startup.ts'

const directories: string[] = []

afterEach(async () => {
  cmdlineInternals.stdout = process.stdout
  cmdlineInternals.stderr = process.stderr
  runnerInternals.stdout = process.stdout
  runnerInternals.stderr = process.stderr
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface InvocationResult {
  code: number
  out: string
  err: string
  authenticationMounted: boolean
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  directories.push(path)
  return path
}

/** Boot the two production plugins through Loader around one isolated Harness home. */
async function invoke(args: string[], dshHome: string): Promise<InvocationResult> {
  const fixture = await temporaryDirectory('dsh-auth-app-loader-')
  await writeFile(join(fixture, 'startup.mjs'), `
export const name = 'auth-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__authAppStartup(ctx)
`)
  await writeFile(join(fixture, 'runner.mjs'), `
export const name = 'auth-runner'
export const inject = ['authStartup']
export const apply = (ctx, config) => globalThis.__authAppRunner(ctx, config)
`)
  await writeFile(join(fixture, 'cordis.yml'), [
    '- id: auth-runner',
    `  name: ${pathToFileURL(join(fixture, 'runner.mjs')).href}`,
    `  inject: [${AUTH_STARTUP_SERVICE}]`,
    '  config:',
    '    operation: !!js ctx.authStartup.operation',
    '    name: !!js ctx.authStartup.name',
    '    publicKey: !!js ctx.authStartup.publicKey',
    '    profile: !!js ctx.authStartup.profile',
    '    capabilities: !!js ctx.authStartup.capabilities',
    `    dshHome: ${JSON.stringify(dshHome)}`,
    '- id: auth-startup',
    `  name: ${pathToFileURL(join(fixture, 'startup.mjs')).href}`,
    '',
  ].join('\n'))

  let out = ''
  let err = ''
  const stdout = { write: (chunk: string) => { out += chunk; return true } }
  const stderr = { write: (chunk: string) => { err += chunk; return true } }
  cmdlineInternals.stdout = stdout
  cmdlineInternals.stderr = stderr
  runnerInternals.stdout = stdout
  runnerInternals.stderr = stderr
  const globals = globalThis as unknown as {
    __authAppStartup: typeof applyStartup
    __authAppRunner: typeof applyRunner
  }
  globals.__authAppStartup = applyStartup
  globals.__authAppRunner = applyRunner

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const exited = new Promise<number>((resolve) => {
    provideCmdline(ctx, { args, exit: resolve })
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(fixture, 'cordis.yml')).href } })
  await ctx.loader.await()
  const code = await exited
  const authenticationMounted = ctx.get('authentication') !== undefined
  await ctx.fiber.dispose()
  return { code, out, err, authenticationMounted }
}

function publicKey(): string {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
}

async function approveOwner(dshHome: string): Promise<void> {
  const request = await createEnrollmentRequest({ name: 'owner', kind: 'device', publicKey: publicKey() }, { dshHome })
  const result = await invoke(['device', 'approve', request.id, '--profile', 'owner'], dshHome)
  if (result.code !== 0) throw new Error(`owner bootstrap failed: ${result.err}`)
}

describe('authentication management app', () => {
  it('approves the first owner device without mounting the network authentication provider', async () => {
    const dshHome = await temporaryDirectory('dsh-auth-app-home-')
    const request = await createEnrollmentRequest({ name: 'laptop', kind: 'device', publicKey: publicKey() }, { dshHome })
    const approved = await invoke(['device', 'approve', request.id, '--profile', 'owner'], dshHome)

    expect(approved).toMatchObject({ code: 0, err: '', authenticationMounted: false })
    expect(approved.out.trim()).toHaveLength(16)
    expect(JSON.parse(await readFile(join(dshHome, 'auth', 'grants.json'), 'utf8'))).toMatchObject({
      version: 1,
      grants: [{ name: 'laptop', kind: 'device', revision: 1 }],
    })
  })

  it('owns enrollment listing, Grant listing, client registration, and revocation output', async () => {
    const dshHome = await temporaryDirectory('dsh-auth-app-home-')
    await approveOwner(dshHome)
    const request = await createEnrollmentRequest({ name: 'phone', kind: 'device', publicKey: publicKey() }, { dshHome })
    const pending = await invoke(['device', 'list'], dshHome)
    const deviceId = (await invoke(['device', 'approve', request.id, '--profile', 'operator'], dshHome)).out.trim()
    const clientId = (await invoke([
      'client', 'add', 'automation', '--public-key', publicKey(), '--capability', 'harniverse.observe', 'harniverse.operate',
    ], dshHome)).out.trim()
    const listed = await invoke(['grant', 'list'], dshHome)
    const revoked = await invoke(['client', 'revoke', clientId], dshHome)

    expect(pending.out).toContain(`${request.id}\t${request.approvalCode}\tphone\tdevice`)
    expect(listed).toMatchObject({ code: 0, err: '' })
    expect(listed.out).toContain(`${deviceId}\tphone\tdevice\tharniverse.observe,harniverse.operate`)
    expect(listed.out).toContain(`${clientId}\tautomation\tapi-client\tharniverse.observe,harniverse.operate`)
    expect(revoked).toMatchObject({ code: 0, out: '', err: '' })
    expect((await invoke(['grant', 'list'], dshHome)).out).not.toContain('automation')
  })

  it('approves administrator and temporary profiles with their capability and expiry semantics', async () => {
    const dshHome = await temporaryDirectory('dsh-auth-app-home-')
    await approveOwner(dshHome)
    const admin = await createEnrollmentRequest({ name: 'desk', kind: 'device', publicKey: publicKey() }, { dshHome })
    const adminId = (await invoke(['device', 'approve', admin.id, '--profile', 'administrator'], dshHome)).out.trim()
    const temporary = await createEnrollmentRequest({ name: 'kiosk', kind: 'device', publicKey: publicKey() }, { dshHome })
    const temporaryId = (await invoke(['device', 'approve', temporary.id, '--profile', 'temporary'], dshHome)).out.trim()
    const bogus = await createEnrollmentRequest({ name: 'unknown', kind: 'device', publicKey: publicKey() }, { dshHome })
    const rejected = await invoke(['device', 'approve', bogus.id, '--profile', 'bogus'], dshHome)

    const listed = await invoke(['grant', 'list'], dshHome)
    expect(listed).toMatchObject({ code: 0, err: '' })
    const rows = new Map(listed.out.trim().split('\n').map(line => [line.split('\t')[1], line.split('\t')]))
    expect(rows.get('desk')).toEqual([
      adminId, 'desk', 'device', 'harniverse.observe,harniverse.operate,harniverse.administer', '-',
    ])
    expect(rows.get('kiosk')?.slice(0, 4)).toEqual([temporaryId, 'kiosk', 'device', 'harniverse.observe,harniverse.operate'])
    expect(rows.get('kiosk')?.[4]).not.toBe('-')
    expect(rejected).toMatchObject({ code: 1, out: '' })
    expect(rejected.err).toContain('unknown capability profile "bogus"')
  })

  it('revokes device and management grants by Grant id', async () => {
    const dshHome = await temporaryDirectory('dsh-auth-app-home-')
    await approveOwner(dshHome)
    const request = await createEnrollmentRequest({ name: 'tablet', kind: 'device', publicKey: publicKey() }, { dshHome })
    const deviceId = (await invoke(['device', 'approve', request.id, '--profile', 'operator'], dshHome)).out.trim()
    const clientId = (await invoke(['client', 'add', 'bot', '--public-key', publicKey(), '--profile', 'administrator'], dshHome)).out.trim()
    const deviceRevoked = await invoke(['device', 'revoke', deviceId], dshHome)
    const grantRevoked = await invoke(['grant', 'revoke', clientId], dshHome)

    expect(deviceRevoked).toMatchObject({ code: 0, out: '', err: '' })
    expect(grantRevoked).toMatchObject({ code: 0, out: '', err: '' })
    const listed = (await invoke(['grant', 'list'], dshHome)).out
    expect(listed).not.toContain(deviceId)
    expect(listed).not.toContain(clientId)
  })

  it('prints app-owned help without activating the runner', async () => {
    const result = await invoke(['--help'], await temporaryDirectory('dsh-auth-app-home-'))
    expect(result.code).toBe(0)
    expect(result.out).toContain('dsh auth')
    expect(result.out).toContain('device')
    expect(result.out).toContain('client')
    expect(result.err).toBe('')
  })

  it('prints app-owned help for an empty invocation', async () => {
    const result = await invoke([], await temporaryDirectory('dsh-auth-app-home-'))
    expect(result.code).toBe(0)
    expect(result.out).toContain('Usage: dsh auth')
    expect(result.err).toBe('')
  })

  it('reports grammar and management failures through bounded exit', async () => {
    const dshHome = await temporaryDirectory('dsh-auth-app-home-')
    const grammar = await invoke(['device', 'approve'], dshHome)
    expect(grammar.code).toBe(1)
    expect(grammar.err).toContain("required option '--profile <profile>' not specified")

    await approveOwner(dshHome)
    await invoke(['client', 'add', 'duplicate', '--public-key', publicKey(), '--profile', 'observer'], dshHome)
    const duplicate = await invoke(['client', 'add', 'duplicate', '--public-key', publicKey(), '--profile', 'observer'], dshHome)
    expect(duplicate.code).toBe(1)
    expect(duplicate.out).toBe('')
    expect(duplicate.err).toContain('already exists')
  })

  it('reports unsupported explicit capabilities through bounded exit', async () => {
    const dshHome = await temporaryDirectory('dsh-auth-app-home-')
    await approveOwner(dshHome)
    const invalid = await invoke([
      'client', 'add', 'badcap', '--public-key', publicKey(), '--capability', 'harniverse.nonsense',
    ], dshHome)
    expect(invalid).toMatchObject({ code: 1, out: '' })
    expect(invalid.err).toContain('--capability values must be supported harniverse.* capabilities')
  })

  it('requires exactly one of --profile or --capability on client add', async () => {
    for (const args of [
      ['client', 'add', 'automation', '--public-key', publicKey(), '--profile', 'observer', '--capability', 'harniverse.observe'],
      ['client', 'add', 'automation', '--public-key', publicKey()],
    ]) {
      const ctx = new Context()
      provideCmdline(ctx, { args, exit: () => {} })
      expect(() => { applyStartup(ctx) }).toThrow('client add requires exactly one of --profile or --capability')
      await ctx.fiber.dispose()
    }
  })

  it('fails loud for invalid runner composition', async () => {
    expect(() => { applyRunner(new Context(), { operation: 'grant-list' }) }).toThrow('must provide ctx.appExit')

    const ctx = new Context()
    let err = ''
    runnerInternals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
    applyRunner(ctx, { operation: 'client-add' })
    expect(await exited).toBe(1)
    expect(err).toContain('client-add requires a client name')

    const bare = new Context()
    const bareExited = new Promise<number>((resolve) => { bare.provide('appExit', resolve) })
    applyRunner(bare, { operation: 'client-add', name: 'automation', publicKey: publicKey() })
    expect(await bareExited).toBe(1)
    expect(err).toContain('--capability values must be supported harniverse.* capabilities')
    await bare.fiber.dispose()
  })
})
