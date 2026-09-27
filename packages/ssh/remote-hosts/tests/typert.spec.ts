import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'
import { expect, it } from 'vitest'

it('generates strict management contracts with capability metadata and no proxy or token Remote', async () => {
  const root = resolve(import.meta.dirname, '../../../..')
  const temp = await mkdtemp(join(tmpdir(), 'hosts-typert-'))
  try {
    const config = join(temp, 'host.json')
    await writeFile(config, JSON.stringify({ extends: join(root, 'tsconfig.base.json'), files: [], include: [],
      references: ['packages/ssh/remote-hosts', 'packages/typert/protocol'].map(path => ({ path: join(root, path, 'tsconfig.json') })) }))
    const workspace = new WorkspaceAnalyzer({ root, hostConfig: config, faces: ['host'], packages: ['@deepseek-ai/dsh-remote-hosts'], checkDiagnostics: false }).analyze()
    const face = workspace.faces[0]!
    const artifact = new FaceModelEmitter(face).emit('@deepseek-ai/dsh-remote-hosts')
    expect(artifact.remote).toBeDefined()
    await symlink(join(root, 'packages/typert/generator/node_modules'), join(temp, 'node_modules'), 'junction')
    const module = join(temp, 'remote.mjs')
    await writeFile(module, artifact.remote!.js)
    const { TYPERT_REMOTE } = await import(/* @vite-ignore */ pathToFileURL(module).href) as {
      TYPERT_REMOTE: { descriptors: Array<{
        method: string
        requiredCapability: string
        parameters: Array<{ codec: { schema: { safeParse(value: unknown): { success: boolean } } } }>
      }> }
    }
    const methods = TYPERT_REMOTE.descriptors
    expect(methods.map(method => method.method).sort()).toEqual(['connect', 'disconnect', 'list', 'probe', 'remove', 'upsert'])
    expect(methods.every(method => method.requiredCapability === (method.method === 'list' ? 'harniverse.observe' : 'harniverse.administer'))).toBe(true)
    const input = methods.find(method => method.method === 'upsert')!.parameters[0]!.codec.schema
    expect(input.safeParse({ name: 'Remote', host: 'example.org', username: 'runner',
      fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', platform: 'linux', architecture: 'x64',
      authentication: { kind: 'password' }, secrets: { kind: 'password', password: 'submitted' }, storeCredentials: true }).success).toBe(true)
    expect(input.safeParse({ secret: 'unexpected' }).success).toBe(false)
  } finally { await rm(temp, { recursive: true, force: true }) }
}, 60_000)
