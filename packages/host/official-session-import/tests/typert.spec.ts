/** The generated Remote contract: one operate-gated namespace with strict wire schemas. */

import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'
import { expect, it } from 'vitest'

interface Schema { safeParse(value: unknown): { success: boolean } }
interface Descriptor {
  method: string
  namespace: string
  requiredCapability: string
  parameters: Array<{ name: string; codec: { schema: Schema } }>
  result: { schema: Schema }
}

it('generates the officialSessionImport contract with operate-gated methods and strict schemas', async () => {
  const root = resolve(import.meta.dirname, '../../../..')
  const temp = await mkdtemp(join(tmpdir(), 'official-session-import-typert-'))
  try {
    const config = join(temp, 'host.json')
    await writeFile(config, JSON.stringify({
      extends: join(root, 'tsconfig.base.json'),
      files: [],
      include: [],
      references: ['packages/host/official-session-import', 'packages/typert/protocol'].map(path => ({ path: join(root, path, 'tsconfig.json') })),
    }))
    const workspace = new WorkspaceAnalyzer({
      root, hostConfig: config, faces: ['host'], packages: ['@deepseek-ai/dsh-host-official-session-import'], checkDiagnostics: false,
    }).analyze()
    const artifact = new FaceModelEmitter(workspace.faces[0]!).emit('@deepseek-ai/dsh-host-official-session-import')
    expect(artifact.remote).toBeDefined()
    // Point the emitted bare `zod` import at the generator's copy by file URL (Windows junctions do not resolve from temp).
    const zodDir = dirname(createRequire(join(root, 'packages/typert/generator/package.json')).resolve('zod/package.json'))
    const source = artifact.remote!.js.replace(/from 'zod'/g, `from '${pathToFileURL(join(zodDir, 'index.js')).href}'`)
    const module = join(temp, 'remote.mjs')
    await writeFile(module, source)
    const loaded = await import(/* @vite-ignore */ pathToFileURL(module).href) as { TYPERT_REMOTE: { descriptors: Descriptor[] } }
    const { TYPERT_REMOTE } = loaded
    const methods = new Map(TYPERT_REMOTE.descriptors.map(descriptor => [descriptor.method, descriptor]))
    expect([...methods.keys()].sort()).toEqual(['importSources', 'importUpload', 'scan'])
    for (const descriptor of methods.values()) {
      expect(descriptor.namespace).toBe('officialSessionImport')
      expect(descriptor.requiredCapability).toBe('harniverse.operate')
    }

    const target = methods.get('importSources')!.parameters[1]!.codec.schema
    expect(target.safeParse({ kind: 'source-cwd' }).success).toBe(true)
    expect(target.safeParse({ kind: 'workspace', workspaceId: 'w' }).success).toBe(true)
    expect(target.safeParse({ kind: 'workspace' }).success).toBe(false)
    expect(target.safeParse({ kind: 'anywhere' }).success).toBe(false)

    const results = methods.get('importSources')!.result.schema
    expect(results.safeParse([
      { source: 's', outcome: { status: 'imported', sessionId: 'a', workspaceId: 'w', attached: true, mappedEvents: 1, skippedEvents: 0 } },
      { source: 's', outcome: { status: 'already-imported', sessionId: 'a' } },
      { source: 's', outcome: { status: 'failed', reason: 'too-large', message: 'm' } },
    ]).success).toBe(true)
    expect(results.safeParse([{ source: 's', outcome: { status: 'failed', reason: 'exploded', message: 'm' } }]).success).toBe(false)

    const scan = methods.get('scan')!.result.schema
    expect(scan.safeParse({
      roots: ['/r'], maxArtifactBytes: 1, unreadable: [{ path: '/r/x', reason: 'invalid', message: 'm' }],
      items: [{ sourceId: '0/p/s/session.v4.jsonl', path: '/r/p/s/session.v4.jsonl', format: 'official-v4', sourceSessionId: 'x', turns: 1, createdAt: 1, updatedAt: 2, sizeBytes: 3, status: 'new' }],
    }).success).toBe(true)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 120_000)
