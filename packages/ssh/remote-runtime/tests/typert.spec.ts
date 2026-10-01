import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkspaceAnalyzer, FaceModelEmitter } from '@deepseek-ai/dsh-typert-generator'
import { expect, it } from 'vitest'

it('generates executable strict Remote schemas for recursive JSON settings and string credentials', async () => {
  const root = resolve(import.meta.dirname, '../../../..')
  const temp = await mkdtemp(join(tmpdir(), 'remote-typert-'))
  try {
    const config = join(temp, 'host.json')
    await writeFile(config, JSON.stringify({
      extends: join(root, 'tsconfig.base.json'), files: [], include: [],
      references: ['packages/ssh/remote-runtime', 'packages/typert/protocol', 'packages/core/session']
        .map(path => ({ path: join(root, path, 'tsconfig.json') })),
    }))
    const workspace = new WorkspaceAnalyzer({
      root, hostConfig: config, faces: ['host'], packages: ['@deepseek-ai/dsh-remote-runtime'], checkDiagnostics: false,
    }).analyze()
    const face = workspace.faces[0]!
    const artifact = new FaceModelEmitter(face).emit('@deepseek-ai/dsh-remote-runtime')
    expect(artifact.remote, JSON.stringify(face.packages.map(pkg => ({ name: pkg.name, invocations: pkg.invocations })))).toBeDefined()
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
    expect(methods.map(method => method.method).sort()).toEqual(['replaceCredentials', 'status', 'syncSettings', 'unlock'])
    const settings = methods.find(method => method.method === 'syncSettings')!.parameters[0]!.codec.schema
    expect(settings.safeParse({ 'model-routes': { routes: { fast: { targets: [{ provider: 'deepseek', model: 'chat' }] } } } }).success).toBe(true)
    expect(settings.safeParse({ unsupported: { fn: () => 1 } }).success).toBe(false)
    const credentials = methods.find(method => method.method === 'replaceCredentials')!.parameters[0]!.codec.schema
    expect(credentials.safeParse({ KEY: 'secret' }).success).toBe(true)
    expect(credentials.safeParse({ KEY: 42 }).success).toBe(false)
  } finally { await rm(temp, { recursive: true, force: true }) }
}, 60_000)
