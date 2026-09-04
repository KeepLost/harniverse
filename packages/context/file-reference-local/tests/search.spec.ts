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

  it('leaves an at sign that opens no token alone', () => {
    // No token at the cursor at all, and a bare `@` mid-word is not one either.
    expect(activeAtToken('plain text', 10)).toBeUndefined()
    expect(activeAtToken('read src/a', 10)).toBeUndefined()
  })

  it('keeps a directory continuation open inside an already-quoted token', () => {
    // The caller is still typing inside the quote, so the closing quote would
    // end a path the user has not finished.
    expect(formatFileMention({ path: 'my docs', kind: 'directory' }, true)).toBe('@"my docs/')
    expect(formatFileMention({ path: 'notes.md', kind: 'file' }, true)).toBe('@"notes.md"')
  })

  it('refuses a directory path carrying control or quote characters', () => {
    expect(formatFileMention({ path: 'has"quote', kind: 'directory' }, false)).toBeUndefined()
  })
})

describe('workspace scan boundaries', () => {
  it('refuses a caller signal that was already aborted', async () => {
    const root = await workspace()
    const value = search(root)

    // Refused before any filesystem work, so the caller's own abort reason is
    // what surfaces.
    await expect(value.list('aa', AbortSignal.abort())).rejects.toThrow()
  })

  it('leaves the shared index alone when one caller cancels', async () => {
    const root = await workspace()
    // Enough directories that the scan is still walking them when the abort
    // lands.
    for (let index = 0; index < 200; index += 1) {
      await mkdir(join(root, `dir-${String(index)}`), { recursive: true })
      await writeFile(join(root, `dir-${String(index)}`, 'file.txt'), 'x')
    }
    const value = search(root)
    const controller = new AbortController()
    const cancelled = value.list('aa', controller.signal)
    await Promise.resolve()
    controller.abort()

    await expect(cancelled).rejects.toThrow()

    // The index is shared across callers, so one caller walking away does not
    // discard the scan the others are still waiting on.
    await expect(value.list('aa', new AbortController().signal))
      .resolves.toEqual([{ path: 'aa.txt', kind: 'file' }])
  })

  it('rescans after the workspace changes under an existing index', async () => {
    const root = await workspace()
    const value = search(root)
    await expect(value.list('cc', new AbortController().signal)).resolves.toEqual([])

    await writeFile(join(root, 'cc.txt'), 'cc')
    // The standing index predates the write, so only an invalidation can make
    // the new file discoverable.
    value.invalidate()

    await expect(value.list('cc', new AbortController().signal))
      .resolves.toEqual([{ path: 'cc.txt', kind: 'file' }])
  })

  it('reports an index failure to the caller that awaited it', async () => {
    const root = await workspace()
    const value = search(root)
    const pending = value.list('aa', new AbortController().signal)
    // Disposal aborts the running scan, and the caller already waiting on that
    // generation must learn it failed rather than hang.
    value.dispose()

    await expect(pending).rejects.toThrow(/file search index (failed|invalidated)/)
  })

  it('reports one directory in name order whatever order it was written in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harniverse-file-reference-order-'))
    roots.push(root)
    // Written newest-name-first so directory order and name order disagree.
    for (const name of ['zz.txt', 'mm.txt', 'aa.txt']) await writeFile(join(root, name), name)
    const value = search(root)

    const listed = await value.list('txt', new AbortController().signal)
    expect(listed.map(candidate => candidate.path)).toEqual(['aa.txt', 'mm.txt', 'zz.txt'])
  })

  it('reads an unreadable workspace as an empty index rather than a failure', async () => {
    const root = await workspace()
    const value = search(root)
    await rm(root, { recursive: true, force: true })

    // Discovery is a convenience surface: a workspace it cannot read offers no
    // candidates instead of failing the caller's completion.
    await expect(value.list('aa', new AbortController().signal)).resolves.toEqual([])
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
