/** The generated Remote contract: capability metadata per method and strict, secret-free wire schemas. */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'
import { expect, it } from 'vitest'

interface Descriptor {
  method: string
  namespace: string
  requiredCapability: string
  parameters: Array<{ codec: { schema: { safeParse(value: unknown): { success: boolean } } } }>
  result: { schema: { safeParse(value: unknown): { success: boolean } } }
}

it('generates the chatBots contract with its capabilities and schemas that admit no secret in a result', async () => {
  const root = resolve(import.meta.dirname, '../../../..')
  const temp = await mkdtemp(join(tmpdir(), 'chat-manager-typert-'))
  try {
    const config = join(temp, 'host.json')
    await writeFile(config, JSON.stringify({
      extends: join(root, 'tsconfig.base.json'),
      files: [],
      include: [],
      references: ['packages/chat/chat-manager', 'packages/typert/protocol'].map(path => ({ path: join(root, path, 'tsconfig.json') })),
    }))
    const workspace = new WorkspaceAnalyzer({
      root, hostConfig: config, faces: ['host'], packages: ['@deepseek-ai/dsh-chat-manager'], checkDiagnostics: false,
    }).analyze()
    const artifact = new FaceModelEmitter(workspace.faces[0]!).emit('@deepseek-ai/dsh-chat-manager')
    expect(artifact.remote).toBeDefined()
    await symlink(join(root, 'packages/typert/generator/node_modules'), join(temp, 'node_modules'), 'junction')
    const module = join(temp, 'remote.mjs')
    await writeFile(module, artifact.remote!.js)
    const loaded = await import(/* @vite-ignore */ pathToFileURL(module).href) as { TYPERT_REMOTE: { descriptors: Descriptor[] } }
    const { TYPERT_REMOTE } = loaded
    const methods = new Map(TYPERT_REMOTE.descriptors.map(descriptor => [descriptor.method, descriptor]))

    expect([...methods.keys()].sort()).toEqual(['addBot', 'checkBot', 'issueOwnerCode', 'removeBot', 'retryBot', 'snapshot', 'unpairOwner', 'updateBot'])
    expect(TYPERT_REMOTE.descriptors.every(descriptor => descriptor.namespace === 'chatBots')).toBe(true)
    for (const [method, descriptor] of methods) {
      expect(descriptor.requiredCapability, method).toBe(method === 'snapshot' ? 'harniverse.observe' : 'harniverse.administer')
    }

    const add = methods.get('addBot')!.parameters[0]!.codec.schema
    expect(add.safeParse({ platform: 'telegram', values: { token: 'x' } }).success).toBe(true)
    expect(add.safeParse({ platform: 'telegram', alias: 'a', values: {} }).success).toBe(true)
    expect(add.safeParse({ platform: 'telegram', values: { token: 1 } }).success).toBe(false)
    expect(add.safeParse({ platform: 'telegram' }).success).toBe(false)

    const update = methods.get('updateBot')!.parameters[0]!.codec.schema
    expect(update.safeParse({ id: 'bot_00000000', enabled: false, settings: { workspace: null, model: null, agentProfile: 'p' } }).success).toBe(true)
    expect(update.safeParse({ id: 'bot_00000000', settings: { model: { provider: 'p', model: 'm', reasoningEffort: 'high' } } }).success).toBe(true)
    expect(update.safeParse({ id: 'bot_00000000', settings: { workspace: 1 } }).success).toBe(false)

    const view = {
      id: 'bot_00000000', platform: 'telegram', alias: 'a', identity: { botId: '1', displayName: 'a' }, values: {},
      secrets: { token: { configured: true, tail: 'cdef' } }, enabled: true, state: 'online', settings: {}, createdAt: 1,
    }
    const result = methods.get('addBot')!.result.schema
    expect(result.safeParse(view).success).toBe(true)
    expect(result.safeParse({ ...view, state: 'exploded' }).success).toBe(false)
    expect(methods.get('snapshot')!.result.schema.safeParse({
      platforms: [{ platform: 'telegram', label: 'Telegram', fields: [{ key: 'token', label: 'x', secret: true, required: true }] }],
      bots: [view], owners: [{ key: 'telegram:1', platform: 'telegram', userId: '1', pairedAt: 0 }], bridge: 'running',
    }).success).toBe(true)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 120_000)
