/** Strict Remote contract generation for the peer namespace. */

import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
    // The emitted module imports `zod` bare; point it at the generator's copy by file URL instead of a node_modules
    // link, which Windows junction resolution does not honour from a temp directory.
    const zodDir = dirname(createRequire(join(root, 'packages/typert/generator/package.json')).resolve('zod/package.json'))
    const zod = pathToFileURL(join(zodDir, 'index.js')).href
    const source = artifact.remote!.js.replace(/from 'zod'/g, `from '${zod}'`)
    expect(source).toContain(zod)
    const module = join(temp, 'peer.mjs')
    await writeFile(module, source)
    const { TYPERT_REMOTE } = await import(/* @vite-ignore */ pathToFileURL(module).href) as {
      TYPERT_REMOTE: { descriptors: Array<{
        method: string
        requiredCapability: string
        parameters: Array<{ codec: { schema: { safeParse(value: unknown): { success: boolean } } } }>
      }> }
    }
    const methods = TYPERT_REMOTE.descriptors
    expect(methods.map(method => method.method)).toEqual(['challenge', 'delegate', 'followup', 'hello', 'sessions'])
    expect(methods.every(method => method.requiredCapability === 'harniverse.peer')).toBe(true)
    const hello = methods.find(method => method.method === 'hello')!
    const schema = hello.parameters[0]!.codec.schema
    expect(schema.safeParse({
      challenge: 'nonce',
      identity: {
        instanceId: '3f2a8f9e-1111-4222-8333-444455556666',
        displayName: 'Laptop',
        platform: 'darwin',
        arch: 'arm64',
        version: '1.0.0-rc.3',
      },
      proof: { publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE', signature: 'MEUCIQD' },
    }).success).toBe(true)
    expect(schema.safeParse({ challenge: 'nonce' }).success).toBe(false)
    expect(schema.safeParse({ identity: { instanceId: 'nope' } }).success).toBe(false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
