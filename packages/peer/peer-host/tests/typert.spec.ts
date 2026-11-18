/** Strict Remote contract generation for the peer namespace. */

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkspaceAnalyzer, FaceModelEmitter } from '@deepseek-ai/dsh-typert-generator'
import { expect, it } from 'vitest'

it('generates one executable strict Remote schema for peer/hello with the pairing capability', { timeout: 30_000 }, async () => {
  const root = resolve(import.meta.dirname, '../../../..')
  const temp = await mkdtemp(join(tmpdir(), 'peer-typert-'))
  try {
    const config = join(temp, 'host.json')
    await writeFile(config, JSON.stringify({
      extends: join(root, 'tsconfig.base.json'), files: [], include: [],
      references: ['packages/peer/peer-host', 'packages/peer/peer-protocol', 'packages/typert/protocol']
        .map(path => ({ path: join(root, path, 'tsconfig.json') })),
    }))
    const workspace = new WorkspaceAnalyzer({
      root, hostConfig: config, faces: ['host'], packages: ['@deepseek-ai/dsh-peer-host'], checkDiagnostics: false,
    }).analyze()
    const face = workspace.faces[0]!
    const artifact = new FaceModelEmitter(face).emit('@deepseek-ai/dsh-peer-host')
    expect(artifact.remote, JSON.stringify(face.packages.map(pkg => ({ name: pkg.name, invocations: pkg.invocations })))).toBeDefined()
    await symlink(join(root, 'packages/typert/generator/node_modules'), join(temp, 'node_modules'), 'junction')
    const module = join(temp, 'peer.mjs')
    await writeFile(module, artifact.remote!.js)
    const { TYPERT_REMOTE } = await import(/* @vite-ignore */ pathToFileURL(module).href) as {
      TYPERT_REMOTE: { descriptors: Array<{
        method: string
        requiredCapability: string
        parameters: Array<{ codec: { schema: { safeParse(value: unknown): { success: boolean } } } }>
      }> }
    }
    const methods = TYPERT_REMOTE.descriptors
    expect(methods.map(method => method.method)).toEqual(['hello'])
    expect(methods[0]!.requiredCapability).toBe('harniverse.peer')
    const identity = methods[0]!.parameters[0]!.codec.schema
    expect(identity.safeParse({
      instanceId: '3f2a8f9e-1111-4222-8333-444455556666',
      displayName: 'Laptop',
      platform: 'darwin',
      arch: 'arm64',
      version: '1.0.0-rc.3',
    }).success).toBe(true)
    expect(identity.safeParse({ instanceId: 'nope' }).success).toBe(false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
