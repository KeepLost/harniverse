/** Loader resolves the source namespace; only the external SSH endpoint is a fixture. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Invariants from '@deepseek-ai/dsh-invariants'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import * as provider from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import { fixture } from './fixture.ts'

it('loads the default service from cordis.yml, delivers bytes and unloads cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-ssh-loader-'))
  const host = await fixture()
  const ctx = new Context()
  try {
    const path = join(directory, 'cordis.yml')
    await writeFile(path, JSON.stringify([
      { name: 'invariants' },
      { name: '@deepseek-ai/dsh-remote-hosts-ssh', config: { maxOutputBytes: 1024 } },
      { name: '@deepseek-ai/dsh-remote-hosts-ssh/invariant' },
    ]))
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['invariants', Invariants],
      ['@deepseek-ai/dsh-remote-hosts-ssh', provider],
      ['@deepseek-ai/dsh-remote-hosts-ssh/invariant', invariant],
    ])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('Unexpected fixture module')
      return modules.get(specifier)
    } } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    const connection = await ctx.remoteHostSsh.open(host.config, { kind: 'password', password: 'fixture-password' })
    const result = await connection.exec('echo input', 'loader input')
    expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode, signal: result.signal })
      .toEqual({ stdout: 'loader input', stderr: 'fixture-stderr', exitCode: 7, signal: null })
    await ctx.fiber.dispose()
    await connection.closed
    expect(ctx.get('remoteHostSsh')).toBeUndefined()
    expect(host.commands).toEqual(['echo input'])
  } finally {
    await ctx.fiber.dispose()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
