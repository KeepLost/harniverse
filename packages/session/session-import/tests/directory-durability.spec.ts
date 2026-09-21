import { describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createContextFixture } from './import-fixture.ts'

const directories = vi.hoisted(() => ({
  paths: new Set<string>(),
  operations: [] as string[],
  failure: undefined as 'open' | 'sync' | undefined,
  failurePath: '',
}))

// Windows cannot open POSIX directory handles. Source files and persistence stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const [path, flags] = args
      if (typeof path !== 'string' || flags !== 'r' || !directories.paths.has(path)) return actual.open(...args)
      directories.operations.push(`open:${path}`)
      if (directories.failure === 'open' && directories.failurePath === path) throw new Error('directory open failed')
      return {
        sync: async () => {
          directories.operations.push(`sync:${path}`)
          if (directories.failure === 'sync' && directories.failurePath === path) throw new Error('directory sync failed')
        },
        close: async () => { directories.operations.push(`close:${path}`) },
      }
    },
  }
})

async function fixture(platform: NodeJS.Platform) {
  const f = await createContextFixture()
  const id = f.sessionId('directory-durability')
  const location = f.persistence.locate({ version: 0, id, createdAt: 1000, cwd: f.root })!
  const sourceDir = dirname(location.path)
  const parentDir = dirname(sourceDir)
  directories.paths = new Set([sourceDir, parentDir])
  directories.operations = []
  directories.failure = undefined
  directories.failurePath = ''
  const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const create = f.persistence.create.bind(f.persistence)
  vi.spyOn(f.persistence, 'create').mockImplementation(async (header) => {
    directories.operations.push('publish')
    // The persistence backend uses the host OS for its native lock implementation.
    platformSpy.mockRestore()
    directories.paths.clear()
    return create(header)
  })
  return { ...f, id, sourceDir, parentDir }
}

describe('archival source directory durability', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('settles source durability before publication on %s', async (platform) => {
    const f = await fixture(platform)
    try {
      const result = await f.importer.import({ artifactPath: f.artifactPath, cwd: f.root, sessionId: f.id })
      expect(directories.operations).toEqual(platform === 'win32' ? ['publish'] : [
        `open:${f.sourceDir}`, `sync:${f.sourceDir}`, `close:${f.sourceDir}`,
        `open:${f.parentDir}`, `sync:${f.parentDir}`, `close:${f.parentDir}`, 'publish',
      ])
      expect(await f.readArtifact(f.id, result.artifactName)).toBe(f.foreignText)
      expect((await f.persistence.load(f.id)).events[0]).toMatchObject({ type: 'import/record' })
    } finally { vi.restoreAllMocks(); directories.paths.clear(); await f.dispose() }
  })

  it.each([
    ['sourceDir', 'open'], ['sourceDir', 'sync'], ['parentDir', 'open'], ['parentDir', 'sync'],
  ] as const)('rolls back without publishing when %s %s fails', async (target, failure) => {
    const f = await fixture('linux')
    try {
      directories.failure = failure
      directories.failurePath = f[target]
      await expect(f.importer.import({ artifactPath: f.artifactPath, cwd: f.root, sessionId: f.id }))
        .rejects.toThrow(`directory ${failure} failed`)
      const completedSource = target === 'parentDir'
        ? [`open:${f.sourceDir}`, `sync:${f.sourceDir}`, `close:${f.sourceDir}`] : []
      expect(directories.operations).toEqual([
        ...completedSource, `open:${f[target]}`,
        ...failure === 'sync' ? [`sync:${f[target]}`, `close:${f[target]}`] : [],
      ])
      await expect(stat(f.sourceDir)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await f.persistence.list()).toEqual([])
    } finally { vi.restoreAllMocks(); directories.paths.clear(); await f.dispose() }
  })
})
