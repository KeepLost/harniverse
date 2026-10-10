/** The generated Remote contract: capability-gated namespace with strict wire schemas. */

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

const HASH = 'a'.repeat(64)
const TOKENS = { '--dsw-accent': '#5e6ad2', '--dsw-alias-bg-base': '#101014' }
const SKIN = { id: 'abyss', source: 'builtin', name: { zh: '沉静蓝', en: 'Deep Blue' }, colorScheme: 'dark', tokens: TOKENS }
const WALLPAPER = { hash: HASH, mime: 'image/png', bytes: 3, addedAt: 1 }

it('generates the skinLibrary contract with observe and administer gating and strict schemas', async () => {
  const root = resolve(import.meta.dirname, '../../../..')
  const temp = await mkdtemp(join(tmpdir(), 'skin-library-typert-'))
  try {
    const config = join(temp, 'host.json')
    await writeFile(config, JSON.stringify({
      extends: join(root, 'tsconfig.base.json'),
      files: [],
      include: [],
      references: ['packages/host/skin-library', 'packages/typert/protocol'].map(path => ({ path: join(root, path, 'tsconfig.json') })),
    }))
    const workspace = new WorkspaceAnalyzer({
      root, hostConfig: config, faces: ['host'], packages: ['@deepseek-ai/dsh-host-skin-library'], checkDiagnostics: false,
    }).analyze()
    const artifact = new FaceModelEmitter(workspace.faces[0]!).emit('@deepseek-ai/dsh-host-skin-library')
    expect(artifact.remote).toBeDefined()
    // Point the emitted bare `zod` import at the generator's copy by file URL (Windows junctions do not resolve from temp).
    const zodDir = dirname(createRequire(join(root, 'packages/typert/generator/package.json')).resolve('zod/package.json'))
    const source = artifact.remote!.js.replace(/from 'zod'/g, `from '${pathToFileURL(join(zodDir, 'index.js')).href}'`)
    const module = join(temp, 'remote.mjs')
    await writeFile(module, source)
    const loaded = await import(/* @vite-ignore */ pathToFileURL(module).href) as { TYPERT_REMOTE: { descriptors: Descriptor[] } }
    const methods = new Map(loaded.TYPERT_REMOTE.descriptors.map(descriptor => [descriptor.method, descriptor]))
    expect([...methods.keys()].sort()).toEqual(['importPack', 'list', 'putWallpaper', 'readWallpaper', 'removePack', 'removeWallpaper'])
    const capabilities = Object.fromEntries([...methods].map(([name, descriptor]) => [name, descriptor.requiredCapability]))
    expect(capabilities).toEqual({
      list: 'harniverse.observe',
      readWallpaper: 'harniverse.observe',
      importPack: 'harniverse.administer',
      removePack: 'harniverse.administer',
      putWallpaper: 'harniverse.administer',
      removeWallpaper: 'harniverse.administer',
    })
    for (const descriptor of methods.values()) expect(descriptor.namespace).toBe('skinLibrary')

    const snapshot = methods.get('list')!.result.schema
    expect(snapshot.safeParse({
      skins: [
        SKIN,
        { ...SKIN, id: 'mine', source: 'pack', author: 'a', description: 'd', accent: '#5e6ad2', background: {
          kind: 'gradient',
          layers: [
            { type: 'radial', at: [20, 10], size: 60, stops: [['#5e6ad240', 0], ['transparent', 100]] },
            { type: 'linear', angle: 165, stops: [['#121216', 0], ['#101016', 100]] },
          ],
        } },
      ],
      wallpapers: [WALLPAPER],
      rejected: [{ file: 'x.json', message: 'm' }],
      limits: { maxPackBytes: 1, maxWallpaperBytes: 2, maxWallpapers: 3 },
    }).success).toBe(true)
    expect(snapshot.safeParse({ skins: [{ ...SKIN, colorScheme: 'sepia' }], wallpapers: [], rejected: [], limits: { maxPackBytes: 1, maxWallpaperBytes: 2, maxWallpapers: 3 } }).success).toBe(false)
    expect(snapshot.safeParse({ skins: [], wallpapers: [{ ...WALLPAPER, mime: 'image/gif' }], rejected: [], limits: { maxPackBytes: 1, maxWallpaperBytes: 2, maxWallpapers: 3 } }).success).toBe(false)

    const read = methods.get('readWallpaper')!
    expect(read.parameters.map(parameter => parameter.name)).toEqual(['hash'])
    expect(read.result.schema.safeParse({ mime: 'image/webp', contentBase64: 'AAAA' }).success).toBe(true)
    expect(read.result.schema.safeParse(undefined).success).toBe(true)
    expect(read.result.schema.safeParse({ mime: 'image/svg+xml', contentBase64: 'AAAA' }).success).toBe(false)

    const imported = methods.get('importPack')!
    expect(imported.parameters.map(parameter => parameter.name)).toEqual(['text'])
    expect(imported.parameters[0]!.codec.schema.safeParse('{}').success).toBe(true)
    expect(imported.parameters[0]!.codec.schema.safeParse(7).success).toBe(false)
    expect(imported.result.schema.safeParse({ status: 'imported', skin: SKIN }).success).toBe(true)
    expect(imported.result.schema.safeParse({ status: 'replaced', skin: SKIN }).success).toBe(true)
    expect(imported.result.schema.safeParse({ status: 'rejected', issues: ['bad'] }).success).toBe(true)
    expect(imported.result.schema.safeParse({ status: 'rejected' }).success).toBe(false)
    expect(imported.result.schema.safeParse({ status: 'imported' }).success).toBe(false)

    const put = methods.get('putWallpaper')!
    expect(put.parameters.map(parameter => parameter.name)).toEqual(['contentBase64'])
    expect(put.result.schema.safeParse({ status: 'stored', wallpaper: WALLPAPER }).success).toBe(true)
    expect(put.result.schema.safeParse({ status: 'existing', wallpaper: WALLPAPER }).success).toBe(true)
    for (const reason of ['invalid-encoding', 'too-large', 'unsupported-type', 'limit-reached']) {
      expect(put.result.schema.safeParse({ status: 'rejected', reason }).success, reason).toBe(true)
    }
    expect(put.result.schema.safeParse({ status: 'rejected', reason: 'because' }).success).toBe(false)

    for (const name of ['removePack', 'removeWallpaper']) {
      expect(methods.get(name)!.result.schema.safeParse(true).success).toBe(true)
      expect(methods.get(name)!.result.schema.safeParse('yes').success).toBe(false)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 120_000)
