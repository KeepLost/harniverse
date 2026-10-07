/** Real Loader composition: the bridge row, real storage rows, the adapter registry, and a fake platform mounted from yaml.
 * Only the Harniverse client is replaced. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ChatAdapters from '@deepseek-ai/dsh-chat-adapter'
import * as FakePlugin from '@deepseek-ai/dsh-chat-adapter-fake'
import type { FakeChatAdapter } from '@deepseek-ai/dsh-chat-adapter-fake'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as BridgePlugin from '../src/index.ts'
import { issueCode } from '../src/pairing.ts'
import { bridgeDomainSpec, type BridgeState } from '../src/state.ts'
import { FakeClient } from './fixtures/fake-client.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function load(client: FakeClient, bridgeRow: string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-chat-bridge-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storage'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-chat-adapter'",
    '- name: test-harniverse-client',
    "- name: '@deepseek-ai/dsh-chat-adapter-fake'",
    '  config:',
    '    platform: fake',
    '    botId: loader-bot',
    "- name: '@deepseek-ai/dsh-chat-bridge'",
    '  config:',
    ...bridgeRow,
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const clientModule = { name: 'test-harniverse-client', apply: (ctx: Context) => { ctx.provide('harniverseClient', client.asClient()) } }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-chat-adapter', ChatAdapters],
    ['test-harniverse-client', clientModule],
    ['@deepseek-ai/dsh-chat-adapter-fake', FakePlugin],
    ['@deepseek-ai/dsh-chat-bridge', BridgePlugin],
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

const BRIDGE_ROW = [
  '    owners:',
  '      - platform: fake',
  '        userId: "1"',
  '    members:',
  '      - id: alice',
  '        platform: fake',
  '        commands: [new, ask, stop]',
  '        workspaces: [home]',
  '        agentProfile: chat-code',
  '    workspaceAliases:',
  '      home: /srv/alice',
  '    streamIntervalMs: 0',
]

describe('real Loader composition', () => {
  it('mounts from yaml, pairs a member with a one-time code, and answers a prompt end to end', async () => {
    const client = new FakeClient()
    const loaded = await load(client, BRIDGE_ROW)
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const adapter = loaded.chatAdapters.get('fake', 'loader-bot') as FakeChatAdapter
    await vi.waitFor(() => { expect(adapter.running).toBe(true) })
    const say = (userId: string, text: string, id: string): Promise<void> => adapter.enqueue({
      type: 'message', messageId: id, route: { kind: 'direct', chatId: userId }, sender: { userId, isBot: false },
      addressed: true, text, controlText: text, attachments: [], platformTime: 1,
    })
    await say('9', 'hello?', 'm0')
    expect(adapter.transcript).toHaveLength(1)
    const state = loaded.storageDomain.get(bridgeDomainSpec.name) as unknown as BridgeState
    const code = await issueCode(state.table('codes'), { kind: 'member', memberId: 'alice', expiresAt: Date.now() + 60_000 })
    await say('9', `/pair ${code}`, 'm1')
    await say('9', 'what is new?', 'm2')
    expect(client.of('session.create')[0]?.payload).toMatchObject({ cwd: '/srv/alice', agentProfile: 'chat-code' })
    const prompt = client.of('session.prompt')[0]!
    const sessionId = String(prompt.payload.sessionId)
    const mux = client.mux()
    await mux.event(sessionId, 0, 'turn/start', { turn: 1 })
    await mux.event(sessionId, 1, 'user/message', { source: { rpcId: prompt.options.rpcId } })
    await mux.event(sessionId, 2, 'assistant/chunk', { chunk: { type: 'text-delta', text: 'Everything.' } })
    await mux.event(sessionId, 3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    const texts = adapter.transcript.flatMap(entry => entry.kind === 'send' || entry.kind === 'edit' ? [entry.message.text] : [])
    expect(texts.at(-1)).toBe('Everything.')
    const persisted = JSON.parse(await readFile(join(root!, 'storage', 'chat_bridge.json'), 'utf8')) as { tables: { members: Record<string, unknown>; sessions: Record<string, unknown> } }
    expect(Object.keys(persisted.tables.members)).toEqual(['fake:9'])
    expect(Object.keys(persisted.tables.sessions)).toEqual([sessionId])
  })

  it('refuses a configuration that names an unknown workspace alias at load time', async () => {
    await expect(load(new FakeClient(), [
      '    members:', '      - id: alice', '        platform: fake', '        workspaces: [nowhere]',
    ])).rejects.toThrow('unknown workspace alias')
  })

  it('refuses an unknown command grant at load time', async () => {
    await expect(load(new FakeClient(), [
      '    members:', '      - id: alice', '        platform: fake', '        commands: [permission]',
    ])).rejects.toThrow()
  })
})
