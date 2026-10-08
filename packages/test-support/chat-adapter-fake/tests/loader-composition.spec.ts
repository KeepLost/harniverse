/** Real Loader composition: the fake row mounts into the chatAdapters registry with capability overrides. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ChatAdapters from '@deepseek-ai/dsh-chat-adapter'
import * as FakePlugin from '../src/index.ts'
import { FakeChatAdapter } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-chat-adapter-fake-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-chat-adapter', ChatAdapters],
    ['@deepseek-ai/dsh-chat-adapter-fake', FakePlugin],
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

describe('real Loader composition', () => {
  it('registers a default fake row with the capable defaults', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-chat-adapter'",
      "- name: '@deepseek-ai/dsh-chat-adapter-fake'",
    ])
    const registered = loaded.chatAdapters.get('fake', 'fake-bot')
    expect(registered).toBeInstanceOf(FakeChatAdapter)
    expect(registered?.capabilities).toEqual(FakePlugin.FAKE_CAPABILITIES)
  })

  it('applies capability overrides from row config', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-chat-adapter'",
      "- name: '@deepseek-ai/dsh-chat-adapter-fake'",
      '  config:',
      '    platform: loader-test',
      '    botId: degraded',
      '    capabilities:',
      '      interactionButtons: false',
      '      editOutbound: false',
      '      editWindowMs: 60000',
      '      maxTextLength: 20',
    ])
    const registered = loaded.chatAdapters.get('loader-test', 'degraded')
    expect(registered?.capabilities).toEqual({
      ...FakePlugin.FAKE_CAPABILITIES, interactionButtons: false, editOutbound: false, editWindowMs: 60_000, maxTextLength: 20,
    })
  })

  it('removes the registration when the row fiber is disposed', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-chat-adapter'",
      "- name: '@deepseek-ai/dsh-chat-adapter-fake'",
    ])
    expect(loaded.chatAdapters.get('fake', 'fake-bot')).toBeDefined()
    const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-chat-adapter-fake')
    await entry!.fiber!.dispose()
    expect(loaded.chatAdapters.get('fake', 'fake-bot')).toBeUndefined()
  })
})
