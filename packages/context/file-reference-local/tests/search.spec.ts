import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { activeAtToken, formatFileMention, WorkspaceFileSearch } from '../src/search.ts'

const roots: string[] = []
const searches: WorkspaceFileSearch[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harniverse-file-reference-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true })
  await writeFile(join(root, 'README.md'), 'readme')
  await writeFile(join(root, 'aa.txt'), 'aa')
  await writeFile(join(root, 'bb.txt'), 'bb')
  await writeFile(join(root, '.env'), 'secret')
  await writeFile(join(root, 'src', 'terminal-view.ts'), 'source')
  await writeFile(join(root, 'node_modules', 'ignored', 'index.js'), 'ignored')
  return root
}

function search(root: string, overrides: Partial<ConstructorParameters<typeof WorkspaceFileSearch>[1]> = {}): WorkspaceFileSearch {
  const value = new WorkspaceFileSearch(root, {
    maxResults: overrides.maxResults ?? 20,
    maxEntries: overrides.maxEntries ?? 10_000,
    excludedDirectories: overrides.excludedDirectories ?? ['.git', 'node_modules'],
  })
  searches.push(value)
  return value
}

afterEach(async () => {
  for (const value of searches.splice(0)) value.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('file reference grammar', () => {
  it('recognizes quoted tokens and rejects email-like at signs', () => {
    expect(activeAtToken('read @"src/terminal v', 21)).toEqual({ prefix: '@"src/terminal v', query: 'src/terminal v', quoted: true })
    expect(activeAtToken('mail a@b.test', 13)).toBeUndefined()
    expect(formatFileMention({ path: 'src/index.ts', kind: 'file' }, false)).toBe('@src/index.ts')
    expect(formatFileMention({ path: 'src', kind: 'directory' }, false)).toBe('@src/')
    expect(formatFileMention({ path: 'docs/a b.md', kind: 'file' }, false)).toBe('@"docs/a b.md"')
    expect(formatFileMention({ path: 'bad\nname', kind: 'file' }, false)).toBeUndefined()
  })
})

describe('WorkspaceFileSearch', () => {
  it('bounds traversal, excludes default directories, descends directories, and rejects escape', async () => {
    const root = await workspace()
    const value = search(root)
    const signal = new AbortController().signal
    await expect(value.list('', signal)).resolves.toEqual([
      { path: 'src', kind: 'directory' },
      { path: 'README.md', kind: 'file' },
      { path: 'aa.txt', kind: 'file' },
      { path: 'bb.txt', kind: 'file' },
    ])
    await expect(value.list('src/', signal)).resolves.toEqual([{ path: 'src/terminal-view.ts', kind: 'file' }])
    await expect(value.list('node_modules/', signal)).resolves.toEqual([])
    await expect(value.list('../', signal)).resolves.toEqual([])
    await expect(value.list('README.md/', signal)).resolves.toEqual([])
  })

  it('covers bounded fuzzy ranking and hidden-file visibility', async () => {
    const root = await workspace()
    const value = search(root)
    const signal = new AbortController().signal
    await mkdir(join(root, 'a'))
    await writeFile(join(root, 'a', 'x.txt'), 'nested')
    await writeFile(join(root, 'abc.txt'), 'abc')

    await expect(value.list('src', signal)).resolves.toEqual([
      { path: 'src', kind: 'directory' },
      { path: 'src/terminal-view.ts', kind: 'file' },
    ])
    await expect(value.list('txt', signal)).resolves.toEqual([
      { path: 'aa.txt', kind: 'file' },
      { path: 'bb.txt', kind: 'file' },
      { path: 'a/x.txt', kind: 'file' },
      { path: 'abc.txt', kind: 'file' },
    ])
    await expect(value.list('view', signal)).resolves.toEqual([{ path: 'src/terminal-view.ts', kind: 'file' }])
    await expect(value.list('tmv', signal)).resolves.toEqual([{ path: 'src/terminal-view.ts', kind: 'file' }])
    await expect(value.list('.env', signal)).resolves.toEqual([{ path: '.env', kind: 'file' }])
    await expect(value.list('missing', signal)).resolves.toEqual([])
  })

  it('handles invalid configuration, missing roots, and non-regular entries', async () => {
    const root = await workspace()
    const signal = new AbortController().signal
    expect(() => search(root, { maxResults: 0 })).toThrow('maxResults')
    expect(() => search(root, { maxEntries: 0 })).toThrow('maxEntries')
    expect(() => search(root, { excludedDirectories: [''] })).toThrow('excludedDirectories')
    expect(() => search(root, { excludedDirectories: ['nested/path'] })).toThrow('excludedDirectories')

    const value = search(root, { maxEntries: 1 })
    await expect(value.list('.env', signal)).resolves.toEqual([{ path: '.env', kind: 'file' }])
    await expect(value.list('not-there/', signal)).resolves.toEqual([])

    const missing = join(root, 'removed')
    const missingSearch = search(missing)
    await expect(missingSearch.list('', signal)).resolves.toEqual([])
    value.dispose()
    value.dispose()
    await expect(value.list('', signal)).resolves.toEqual([])
  })

  it('does not follow directory symlinks and invalidates the fuzzy index', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'harniverse-file-reference-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const value = search(root)
    const signal = new AbortController().signal
    await expect(value.list('escape/', signal)).resolves.toEqual([])
    await expect(value.list('', signal)).resolves.toEqual([
      { path: 'src', kind: 'directory' },
      { path: 'README.md', kind: 'file' },
      { path: 'aa.txt', kind: 'file' },
      { path: 'bb.txt', kind: 'file' },
    ])
    await expect(value.list('README', signal)).resolves.toEqual([{ path: 'README.md', kind: 'file' }])
    await writeFile(join(root, 'fresh.ts'), 'fresh')
    await expect(value.list('fresh', signal)).resolves.toEqual([])
    value.invalidate()
    await expect(value.list('fresh', signal)).resolves.toEqual([{ path: 'fresh.ts', kind: 'file' }])
  })

  it('cancels callers without cancelling a later search and enforces limits', async () => {
    const root = await workspace()
    expect(() => search(root, { maxResults: 0 })).toThrow('maxResults')
    const value = search(root)
    const controller = new AbortController()
    controller.abort(new Error('superseded'))
    await expect(value.list('terminal', controller.signal)).rejects.toThrow('superseded')
    await expect(value.list('terminal', new AbortController().signal)).resolves.toEqual([{ path: 'src/terminal-view.ts', kind: 'file' }])
  })

  it('cancels an in-flight caller and invalidates an in-flight index', async () => {
    const root = await workspace()
    const value = search(root)
    const caller = new AbortController()
    const pending = value.list('README', caller.signal)
    caller.abort('caller cancelled')
    await expect(pending).rejects.toThrow('file search aborted')

    const invalidated = value.list('README', new AbortController().signal)
    value.invalidate()
    await expect(invalidated).rejects.toThrow('file search index invalidated')
  })
})
