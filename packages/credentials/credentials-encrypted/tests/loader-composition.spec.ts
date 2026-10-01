import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as EncryptedCredentials from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

it('loads the default service from cordis.yml while locked and recovers only after runtime unlock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-encrypted-composition-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'cordis.yml')
  const path = join(root, 'credentials.json')
  await writeFile(configPath, [
    '- id: credentials',
    '  name: "@deepseek-ai/dsh-credentials-encrypted"',
    '  config:',
    `    path: ${JSON.stringify(path)}`,
    '',
  ].join('\n'))

  async function load() {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-credentials-encrypted') throw new Error('unexpected composition import')
        return EncryptedCredentials
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const provider = ctx.credentials
    if (!(provider instanceof EncryptedCredentials.EncryptedCredentialProvider)) throw new Error('service not mounted')
    return { ctx, provider }
  }

  const first = await load()
  const ref = credentialRef('MODEL_KEY')
  expect(first.provider.status()).toEqual({ locked: true })
  expect(await first.provider.describe(ref)).toEqual({ configured: false, writable: false })
  await expect(first.ctx.credentials.resolve(ref)).rejects.toThrow(/locked/)
  const key = randomBytes(32).toString('base64url')
  await first.provider.unlock(key)
  await first.provider.replace({ MODEL_KEY: 'composition-secret' })
  expect(await readFile(path, 'utf8')).not.toContain('composition-secret')
  await first.ctx.fiber.dispose()

  const next = await load()
  expect(next.provider.status()).toEqual({ locked: true })
  await next.provider.unlock(key)
  expect(await next.ctx.credentials.resolve(ref)).toEqual({ value: 'composition-secret', source: 'encrypted' })
})
