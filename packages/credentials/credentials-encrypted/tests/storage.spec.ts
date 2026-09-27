import { afterEach, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDocument, UncertainCommitError, writeDocument } from '../src/storage.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
})

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(open).mockReset()
  vi.mocked(rename).mockReset()
  while (cleanups.length) await cleanups.pop()!()
})

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-encrypted-storage-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return { dir, path: join(dir, 'credentials.json') }
}

it.each(['write', 'sync', 'rename'] as const)('retains the old file and removes temporary ciphertext on %s failure', async (phase) => {
  const { dir, path } = await store()
  await writeDocument(path, 'old encrypted envelope')
  const sensitiveError = new Error('sensitive storage detail')
  if (phase === 'rename') vi.mocked(rename).mockRejectedValueOnce(sensitiveError)
  else {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args)
      if (phase === 'write') vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(sensitiveError)
      else vi.spyOn(handle, 'sync').mockRejectedValueOnce(sensitiveError)
      return handle
    })
  }
  await expect(writeDocument(path, 'next encrypted envelope')).rejects.toThrow('credentials-encrypted: could not persist credential snapshot')
  expect(await readFile(path, 'utf8')).toBe('old encrypted envelope')
  expect(await readdir(dir)).toEqual(['credentials.json'])
})

it.skipIf(process.platform === 'win32')('distinguishes a directory sync failure after rename from rollback', async () => {
  const { dir, path } = await store()
  await writeDocument(path, 'old encrypted envelope')
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args)
    if (args[0] === dir) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('sync failed'))
    return handle
  })
  await expect(writeDocument(path, 'next encrypted envelope')).rejects.toBeInstanceOf(UncertainCommitError)
  expect(await readFile(path, 'utf8')).toBe('next encrypted envelope')
  expect(await readdir(dir)).toEqual(['credentials.json'])
})

it.skipIf(process.platform === 'win32')('refuses a commit when a newly created directory cannot be durably linked', async () => {
  const { dir } = await store()
  const path = join(dir, 'new', 'nested', 'credentials.json')
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args)
    if (args[0] === dir) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('ancestor sync failed'))
    return handle
  })
  await expect(writeDocument(path, 'encrypted envelope')).rejects.toThrow(/could not persist/)
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('treats only missing files as empty and bounds reads', async () => {
  const { path } = await store()
  expect(await readDocument(path)).toBeUndefined()
  await writeFile(path, 'x'.repeat(1_500_000), { mode: 0o600 })
  expect((await readDocument(path))?.length).toBe(1_500_000)
  await writeFile(path, 'x'.repeat(1_500_001))
  await expect(readDocument(path)).rejects.toThrow(/oversized|invalid/)
})

it.skipIf(process.platform === 'win32')('refuses final-component symlinks without touching their referents', async () => {
  const { dir, path } = await store()
  const target = join(dir, 'other.json')
  await writeFile(target, 'other encrypted envelope', { mode: 0o600 })
  await symlink(target, path)
  await expect(readDocument(path)).rejects.toThrow()
  expect(await readFile(target, 'utf8')).toBe('other encrypted envelope')
})

it.skipIf(process.platform === 'win32')('rejects a shared parent directory before writing ciphertext', async () => {
  const { dir, path } = await store()
  await chmod(dir, 0o755)
  await expect(writeDocument(path, 'encrypted envelope')).rejects.toThrow(/could not persist/)
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
