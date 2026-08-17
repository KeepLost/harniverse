/** Authentication management through the real startup/runner Loader composition. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals as cmdlineInternals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
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

describe('authentication management app', () => {
  it('creates the first token without mounting the network authentication provider', async () => {
    const dshHome = await temporaryDirectory('dsh-auth-app-home-')
    const added = await invoke(['token', 'add', 'laptop'], dshHome)

    expect(added).toMatchObject({ code: 0, err: '', authenticationMounted: false })
    expect(added.out.trim()).toMatch(/^dsh1_/)
    expect(JSON.parse(await readFile(join(dshHome, 'auth', 'tokens.json'), 'utf8'))).toMatchObject({
      version: 1,
      tokens: [{ name: 'laptop', generation: 1 }],
    })
  })

  it('owns add, list, reset, and delete output semantics', async () => {
    const dshHome = await temporaryDirectory('dsh-auth-app-home-')
    const first = (await invoke(['token', 'add', 'phone'], dshHome)).out.trim()
    const listed = await invoke(['token', 'list'], dshHome)
    const reset = await invoke(['token', 'reset', 'phone'], dshHome)
    const deleted = await invoke(['token', 'delete', 'phone'], dshHome)

    expect(listed).toMatchObject({ code: 0, err: '' })
    expect(listed.out).toContain('phone')
    expect(listed.out).not.toContain(first)
    expect(reset).toMatchObject({ code: 0, err: '' })
    expect(reset.out.trim()).toMatch(/^dsh1_/)
    expect(reset.out.trim()).not.toBe(first)
    expect(deleted).toMatchObject({ code: 0, out: '', err: '' })
    expect((await invoke(['token', 'list'], dshHome)).out).toBe('')
  })

  it('prints app-owned help without activating the runner', async () => {
    const result = await invoke(['--help'], await temporaryDirectory('dsh-auth-app-home-'))
    expect(result.code).toBe(0)
    expect(result.out).toContain('dsh auth')
    expect(result.out).toContain('token')
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
    const grammar = await invoke(['token', 'add'], dshHome)
    expect(grammar.code).toBe(1)
    expect(grammar.err).toContain('missing required argument')

    await invoke(['token', 'add', 'duplicate'], dshHome)
    const duplicate = await invoke(['token', 'add', 'duplicate'], dshHome)
    expect(duplicate.code).toBe(1)
    expect(duplicate.out).toBe('')
    expect(duplicate.err).toContain('already exists')
  })

  it('fails loud for invalid runner composition', async () => {
    expect(() => { applyRunner(new Context(), { operation: 'list' }) }).toThrow('must provide ctx.appExit')

    const ctx = new Context()
    let err = ''
    runnerInternals.stderr = { write: (chunk: string) => { err += chunk; return true } }
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
    applyRunner(ctx, { operation: 'add' })
    expect(await exited).toBe(1)
    expect(err).toContain('add requires a token name')
  })
})
