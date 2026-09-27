import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireHomeOwnership } from '../src/home-ownership.ts'

const roots: string[] = []
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rmdir: vi.fn(actual.rmdir) }
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['ENOTEMPTY', 'ENOENT', 'EPERM'])('releases safely when a successor races directory removal (%s)', async (errorCode) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-handoff-'))
  roots.push(root)
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  let successor: Awaited<ReturnType<typeof acquireHomeOwnership>> | undefined
  const { rmdir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.rmdir).mockImplementationOnce(async (path) => {
    successor = await acquireHomeOwnership(home)
    if (errorCode === 'ENOTEMPTY') return rmdir(path)
    throw Object.assign(new Error('vacated directory changed'), { code: errorCode })
  })
  try {
    await expect(owner.release()).resolves.toBeUndefined()
    await expect(acquireHomeOwnership(home)).rejects.toThrow(/already running/)
  } finally {
    await successor?.release()
  }
})

it('admits only one process owner for a home and allows a later owner after release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-'))
  roots.push(root)
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  try {
    await expect(acquireHomeOwnership(home)).rejects.toThrow(/already running/)
  } finally {
    await owner.release()
  }
  const successor = await acquireHomeOwnership(home)
  await Promise.all([successor.release(), successor.release()])
})

it('treats a symlink to the same home as the same owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-alias-'))
  roots.push(root)
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  try {
    const alias = join(root, 'alias')
    await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(acquireHomeOwnership(alias)).rejects.toThrow(/already running/)
  } finally {
    await owner.release()
  }
})

it('admits exactly one of several simultaneous contenders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-contended-'))
  roots.push(root)
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireHomeOwnership(join(root, 'home'))))
  const winners = attempts.filter(result => result.status === 'fulfilled')
  expect(winners).toHaveLength(1)
  expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(7)
  if (winners[0]?.status === 'fulfilled') await winners[0].value.release()
})

it('recovers a lease left by a dead process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-crashed-'))
  roots.push(root)
  const home = join(root, 'home')
  const lease = join(home, 'runtime', 'instance.lease')
  const nonce = '00000000000000000000000000000000'
  await mkdir(lease, { recursive: true })
  await writeFile(join(lease, `owner-${nonce}.json`), JSON.stringify({ pid: 2_147_483_647, nonce }))
  const owner = await acquireHomeOwnership(home)
  await owner.release()
})

it('excludes a different process until ownership is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-other-process-'))
  roots.push(root)
  const home = join(root, 'home')
  const script = `import { acquireHomeOwnership } from ${JSON.stringify(new URL('../src/home-ownership.ts', import.meta.url).href)}; await acquireHomeOwnership()`
  const attempt = () => spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
    cwd: new URL('../../../../', import.meta.url),
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 20_000,
  })
  const owner = await acquireHomeOwnership(home)
  try {
    const contender = attempt()
    expect(contender.status).not.toBe(0)
    expect(contender.stderr).toContain('already running')
  } finally {
    await owner.release()
  }
  const successor = attempt()
  expect(successor.status).toBe(0)
  expect(successor.stderr).toBe('')
})
