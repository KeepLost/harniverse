import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishEndpoint } from '../src/endpoint.ts'
import type { RuntimeEndpoint } from '../src/types.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), unlink: vi.fn(actual.unlink) }
})

const endpoint: RuntimeEndpoint = {
  version: 1, host: '127.0.0.1', port: 42001, protocol: 'http:', pid: 1234,
  bootId: '11111111-1111-4111-8111-111111111111',
}

it('preserves successor and malformed endpoint descriptors during cleanup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-runtime-endpoint-'))
  try {
    const dispose = await publishEndpoint(home, endpoint)
    const path = join(home, 'server', 'endpoint.json')
    await writeFile(path, JSON.stringify({ ...endpoint, bootId: '22222222-2222-4222-8222-222222222222' }))
    await dispose()
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ bootId: '22222222-2222-4222-8222-222222222222' })

    const second = await publishEndpoint(home, endpoint)
    await writeFile(path, '{broken')
    await second()
    expect(await readFile(path, 'utf8')).toBe('{broken')

    await unlink(path)
    await second()
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('rejects a server directory symlink before publishing a descriptor', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-runtime-endpoint-link-'))
  const target = join(home, 'target')
  try {
    await mkdir(target)
    await symlink(target, join(home, 'server'))
    await expect(publishEndpoint(home, endpoint)).rejects.toThrow(/must not be a symlink/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('removes the descriptor it still owns on disposal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-runtime-endpoint-owned-'))
  try {
    const dispose = await publishEndpoint(home, endpoint)
    const path = join(home, 'server', 'endpoint.json')
    await dispose()
    await dispose()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('contains an already-removed descriptor and propagates other unlink failures', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-runtime-endpoint-unlink-'))
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  try {
    const dispose = await publishEndpoint(home, endpoint)
    vi.mocked(unlink).mockImplementationOnce(async (path) => {
      if (String(path).endsWith('endpoint.json')) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return actual.unlink(path)
    })
    await expect(dispose()).resolves.toBeUndefined()
    const next = await publishEndpoint(home, { ...endpoint, bootId: '22222222-2222-4222-8222-222222222222' })
    vi.mocked(unlink).mockImplementationOnce(async (path) => {
      if (String(path).endsWith('endpoint.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return actual.unlink(path)
    })
    await expect(next()).rejects.toMatchObject({ code: 'EACCES' })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('propagates descriptor read failures during owner cleanup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-runtime-endpoint-read-error-'))
  try {
    const dispose = await publishEndpoint(home, endpoint)
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'EIO' }))
    await expect(dispose()).rejects.toMatchObject({ code: 'EIO' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('propagates non-absence failures while cleaning the temporary descriptor', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-runtime-endpoint-temp-cleanup-'))
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  try {
    vi.mocked(unlink).mockImplementationOnce(async (path) => {
      if (String(path).includes('.endpoint-')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return actual.unlink(path)
    })
    await expect(publishEndpoint(home, endpoint)).rejects.toMatchObject({ code: 'EACCES' })
  } finally { await rm(home, { recursive: true, force: true }) }
})
