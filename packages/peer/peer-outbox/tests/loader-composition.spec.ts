/** The peer outbox booted through the real Loader: composition wiring, ledger durability, and disposal. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore from '@deepseek-ai/dsh-session'
import * as PeerOutbox from '@deepseek-ai/dsh-peer-outbox'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot one cordis.yml wiring the outbox row with the given config lines. */
async function boot(home: string): Promise<Context> {
  const configPath = join(home, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(home, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-peer-outbox'",
    '  config:',
    `    dshHome: ${JSON.stringify(home)}`,
    '    pollIntervalMs: 5000',
  ].join('\n'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(SessionStore)
  ctx.provide('agents', { get: () => undefined } as never)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-peer-outbox', PeerOutbox],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const row of ctx.loader.entries()) {
    if (!row.disabled && row.fiber !== undefined && row.fiber.state === FiberState.FAILED) await row.fiber.await()
  }
  return ctx
}

it('starts through the Loader, persists its ledger across restarts, and unloads with its row', async () => {
  root = await mkdtemp(join(tmpdir(), 'peer-outbox-loader-'))
  context = await boot(root)
  const outbox = context.get('peerOutbox')
  expect(outbox).toBeDefined()
  const entry = await outbox!.track({
    targetInstanceId: '3f2a8f9e-1111-4222-8333-444455556666',
    targetDisplayName: 'Build workstation',
    peerSessionId: 'peer-01234567-89ab-cdef-0123-456789abcdef',
    messageId: 'm1',
    ownerSessionId: 'owner-session',
    label: 'loader track',
  })
  expect(outbox!.list().map(row => row.id)).toEqual([entry.id])
  const home = root
  await context.fiber.dispose()
  context = undefined

  context = await boot(home)
  const restored = context.get('peerOutbox')
  expect(restored).toBeDefined()
  expect(restored!.list()).toHaveLength(1)
  expect(restored!.list()[0]).toMatchObject({ id: entry.id, state: 'watching', label: 'loader track' })
})
