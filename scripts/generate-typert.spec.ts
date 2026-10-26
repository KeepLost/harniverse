import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  computeFingerprint,
  fingerprintProjectRoots,
  orchestrateGeneration,
  shouldSkipGeneration,
  typertCachePath,
} from './generate-typert.ts'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-generate-typert-'))
  roots.push(root)
  return root
}

function write(path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

interface Project {
  name: string
  references?: string[]
}

/** Write one referenced-project fixture root with the host aggregate on top. */
function writeWorkspace(root: string, projects: Project[]): void {
  write(
    join(root, 'tsconfig.host.json'),
    JSON.stringify({ files: [], references: projects.map(project => ({ path: `packages/${project.name}` })) }),
  )
  write(join(root, 'tsconfig.base.json'), '{}\n')
  write(join(root, 'node_modules/typescript/package.json'), JSON.stringify({ version: '6.9.999' }))
  for (const project of projects) {
    const dir = join(root, 'packages', project.name)
    write(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { composite: true },
        include: ['src'],
        ...(project.references === undefined ? {} : { references: project.references.map(path => ({ path })) }),
      }),
    )
    write(join(dir, 'src/index.ts'), `export const ${project.name} = 1\n`)
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('fingerprintProjectRoots', () => {
  it('follows aggregate references transitively to project directories', () => {
    const root = fixture()
    writeWorkspace(root, [
      { name: 'a', references: ['../shared'] },
      { name: 'b' },
    ])
    write(join(root, 'packages/shared/tsconfig.json'), JSON.stringify({ compilerOptions: { composite: true }, include: ['src'] }))
    write(join(root, 'packages/shared/src/index.ts'), 'export {}\n')

    const rootsRelative = fingerprintProjectRoots(root)
      .map(dir => dir.slice(root.length + 1).replaceAll('\\', '/'))
      .sort()
    expect(rootsRelative).toEqual(['packages/a', 'packages/b', 'packages/shared'])
  })
})

describe('computeFingerprint', () => {
  it('is stable across calls and ignores lib and tests trees', () => {
    const root = fixture()
    writeWorkspace(root, [{ name: 'a' }])
    write(join(root, 'packages/a/lib/stale.js'), 'old\n')
    write(join(root, 'packages/a/tests/a.spec.ts'), 'changed later\n')

    const first = computeFingerprint(root)
    expect(computeFingerprint(root)).toBe(first)

    write(join(root, 'packages/a/lib/stale.js'), 'new\n')
    expect(computeFingerprint(root)).toBe(first)

    write(join(root, 'packages/a/tests/a.spec.ts'), 'edited\n')
    expect(computeFingerprint(root)).toBe(first)
  })

  it('changes when a source file, the base config, or the TypeScript version changes', () => {
    const root = fixture()
    writeWorkspace(root, [{ name: 'a' }])
    const first = computeFingerprint(root)

    write(join(root, 'packages/a/src/index.ts'), 'export const a = 2\n')
    const afterSource = computeFingerprint(root)
    expect(afterSource).not.toBe(first)

    write(join(root, 'tsconfig.base.json'), '{"strict":true}\n')
    expect(computeFingerprint(root)).not.toBe(afterSource)

    write(join(root, 'node_modules/typescript/package.json'), JSON.stringify({ version: '6.9.1000' }))
    expect(computeFingerprint(root)).not.toBe(afterSource)
  })
})

describe('shouldSkipGeneration', () => {
  it('skips only when the fingerprint matches and every artifact exists', () => {
    const cache = { fingerprint: 'f1', artifacts: ['packages/a/lib/typert.host.js'] }
    expect(shouldSkipGeneration(undefined, 'f1', () => true)).toBe(false)
    expect(shouldSkipGeneration(cache, 'f2', () => true)).toBe(false)
    expect(shouldSkipGeneration(cache, 'f1', () => false)).toBe(false)
    expect(shouldSkipGeneration(cache, 'f1', file => file !== 'packages/a/lib/typert.host.js')).toBe(false)
    expect(shouldSkipGeneration(cache, 'f1', () => true)).toBe(true)
  })
})

describe('orchestrateGeneration', () => {
  it('generates and records the cache on a miss', async () => {
    const root = fixture()
    writeWorkspace(root, [{ name: 'a' }])
    const written: unknown[] = []
    const result = orchestrateGeneration(root, {
      fingerprint: 'f1',
      readCache: () => undefined,
      writeCache: cache => written.push(cache),
      generate: () => ['packages/a/lib/typert.host.js'],
    })
    expect(result).toBe('generated')
    expect(written).toEqual([{ fingerprint: 'f1', artifacts: ['packages/a/lib/typert.host.js'] }])
  })

  it('skips generation on a fingerprint hit with artifacts present', async () => {
    const root = fixture()
    writeWorkspace(root, [{ name: 'a' }])
    write(join(root, 'packages/a/lib/typert.host.js'), 'artifact\n')
    let generated = false
    const result = orchestrateGeneration(root, {
      fingerprint: 'f1',
      readCache: () => ({ fingerprint: 'f1', artifacts: ['packages/a/lib/typert.host.js'] }),
      writeCache: () => { generated = true },
      generate: () => { generated = true; return [] },
    })
    expect(result).toBe('skipped')
    expect(generated).toBe(false)
  })

  it('leaves the cache untouched when generation fails', () => {
    const root = fixture()
    writeWorkspace(root, [{ name: 'a' }])
    let wrote = false
    expect(() => orchestrateGeneration(root, {
      fingerprint: 'f1',
      readCache: () => undefined,
      writeCache: () => { wrote = true },
      generate: () => { throw new Error('analysis failed') },
    })).toThrow('analysis failed')
    expect(wrote).toBe(false)
  })
})

describe('typertCachePath', () => {
  it('lives under node_modules/.cache/dsh', () => {
    expect(typertCachePath('/repo').replaceAll('\\', '/')).toBe('/repo/node_modules/.cache/dsh/generate-typert.json')
  })
})
