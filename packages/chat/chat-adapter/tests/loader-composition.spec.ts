/** Real Loader composition: provider rows register into ctx.chatAdapters and dispose with their fiber. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ChatAdapters from '../src/index.ts'
import { apply, inject, name } from './fixtures/mount-provider.ts'
import * as platformProvider from './fixtures/platform-provider.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-chat-adapter-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-chat-adapter', ChatAdapters],
    ['stub-adapter-provider', { name, inject, apply }],
    ['stub-platform-provider', { name: platformProvider.name, inject: platformProvider.inject, apply: platformProvider.apply }],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

const registryRow = "- name: '@deepseek-ai/dsh-chat-adapter'"

function providerRows(botId: string): string[] {
  return ['- name: stub-adapter-provider', '  config:', '    platform: telegram', `    botId: ${botId}`]
}

function platformRow(platform: string): string[] {
  return ['- name: stub-platform-provider', '  config:', `    platform: ${platform}`]
}

describe('real Loader composition', () => {
  it('registers provider rows from yaml into the registry', async () => {
    const loaded = await loadYaml([registryRow, ...providerRows('bot-1'), ...providerRows('bot-2')])
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.chatAdapters.list().map(entry => entry.botId)).toEqual(['bot-1', 'bot-2'])
  })

  it('removes the registration when the provider fiber is disposed', async () => {
    const loaded = await loadYaml([registryRow, ...providerRows('bot-1')])
    expect(loaded.chatAdapters.get('telegram', 'bot-1')).toBeDefined()
    const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === 'stub-adapter-provider')
    await entry!.fiber!.dispose()
    expect(loaded.chatAdapters.get('telegram', 'bot-1')).toBeUndefined()
  })

  it('fails the Loader load when a second row mounts the same platform:botId', async () => {
    await expect(loadYaml([registryRow, ...providerRows('clash'), ...providerRows('clash')]))
      .rejects.toThrow('already registered')
  })

  it('exposes platform descriptors from provider rows in row order', async () => {
    const loaded = await loadYaml([registryRow, ...platformRow('telegram'), ...platformRow('feishu'), ...providerRows('bot-1')])
    expect(loaded.chatAdapters.platforms().map(entry => entry.platform)).toEqual(['telegram', 'feishu'])
    expect(loaded.chatAdapters.platform('feishu')?.label).toBe('feishu')
    expect(loaded.chatAdapters.list().map(entry => entry.botId)).toEqual(['bot-1'])
  })

  it('removes the descriptor when the provider fiber is disposed', async () => {
    const loaded = await loadYaml([registryRow, ...platformRow('telegram')])
    expect(loaded.chatAdapters.platform('telegram')).toBeDefined()
    const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === 'stub-platform-provider')
    await entry!.fiber!.dispose()
    expect(loaded.chatAdapters.platform('telegram')).toBeUndefined()
  })

  it('fails the Loader load when a second row registers the same platform', async () => {
    await expect(loadYaml([registryRow, ...platformRow('telegram'), ...platformRow('telegram')]))
      .rejects.toThrow('platform telegram is already registered')
  })
})
