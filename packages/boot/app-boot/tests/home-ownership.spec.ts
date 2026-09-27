import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireHomeOwnership } from '../src/home-ownership.ts'

const roots: string[] = []
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    rmdir: vi.fn(actual.rmdir),
    writeFile: vi.fn(actual.writeFile),
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.readdir).mockClear()
  vi.mocked(fs.rename).mockClear()
  vi.mocked(fs.rm).mockClear()
  vi.mocked(fs.rmdir).mockClear()
  vi.mocked(fs.writeFile).mockClear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('waits through an empty lease directory before acquiring ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-empty-'))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(join(home, 'runtime', 'instance.lease'), { recursive: true })
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('lease exists'), { code: 'EEXIST' }))
  const owner = await acquireHomeOwnership(home)
  await owner.release()
})

it('rejects invalid owner records instead of taking over the lease', async () => {
  const cases: Array<[string, string, unknown]> = [
    ['malformed JSON', 'owner-not-json.json', 'not-json'],
    ['multiple files', 'owner-00000000000000000000000000000000.json', { pid: process.pid, nonce: '00000000000000000000000000000000' }],
    ['null owner', 'owner-11111111111111111111111111111111.json', null],
    ['unsafe pid', 'owner-22222222222222222222222222222222.json', { pid: Number.MAX_SAFE_INTEGER + 1, nonce: '22222222222222222222222222222222' }],
    ['dead pid value', 'owner-33333333333333333333333333333333.json', { pid: 0, nonce: '33333333333333333333333333333333' }],
    ['non-string nonce', 'owner-44444444444444444444444444444444.json', { pid: process.pid, nonce: 4 }],
    ['filename mismatch', 'owner-55555555555555555555555555555555.json', { pid: process.pid, nonce: '66666666666666666666666666666666' }],
  ]
  for (const [label, filename, value] of cases) {
    const root = await mkdtemp(join(tmpdir(), `dsh-home-owner-invalid-${label.replaceAll(' ', '-')}-`))
    roots.push(root)
    const home = join(root, 'home')
    const lease = join(home, 'runtime', 'instance.lease')
    await mkdir(lease, { recursive: true })
    await writeFile(join(lease, filename), typeof value === 'string' ? value : JSON.stringify(value))
    await expect(acquireHomeOwnership(home)).rejects.toThrow()
    await rm(root, { recursive: true, force: true })
    roots.pop()
  }
})

it('rejects a lease with more than one owner file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-multiple-'))
  roots.push(root)
  const home = join(root, 'home')
  const lease = join(home, 'runtime', 'instance.lease')
  await mkdir(lease, { recursive: true })
  await writeFile(join(lease, 'owner-77777777777777777777777777777777.json'), JSON.stringify({
    pid: process.pid, nonce: '77777777777777777777777777777777',
  }))
  await writeFile(join(lease, 'owner-88888888888888888888888888888888.json'), JSON.stringify({
    pid: process.pid, nonce: '88888888888888888888888888888888',
  }))
  await expect(acquireHomeOwnership(home)).rejects.toThrow(/invalid home owner/)
})

it('propagates a candidate owner write failure and cleans the candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-write-failure-'))
  roots.push(root)
  const home = join(root, 'home')
  const error = new Error('owner write failed')
  vi.mocked(fs.writeFile).mockRejectedValueOnce(error)
  await expect(acquireHomeOwnership(home)).rejects.toBe(error)
  expect(await readdir(join(home, 'runtime'))).toEqual([])
})

it('refuses to release a lease whose owner record changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-replaced-'))
  roots.push(root)
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  const lease = join(home, 'runtime', 'instance.lease')
  const [current] = await readdir(lease)
  await rm(join(lease, current!))
  const nonce = '99999999999999999999999999999999'
  await writeFile(join(lease, `owner-${nonce}.json`), JSON.stringify({ pid: process.pid, nonce }))
  await expect(owner.release()).rejects.toThrow('refusing to release')
})

it('supports independent profile ownership scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-profile-'))
  roots.push(root)
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home, { profile: 'work' })
  try {
    await expect(acquireHomeOwnership(home, { profile: 'work' })).rejects.toThrow(/profile "work"/)
    const other = await acquireHomeOwnership(home, { profile: 'other' })
    await other.release()
  } finally {
    await owner.release()
  }
})

it('propagates unexpected candidate rename failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-rename-failure-'))
  roots.push(root)
  const home = join(root, 'home')
  const error = Object.assign(new Error('rename refused'), { code: 'EACCES' })
  vi.mocked(fs.rename).mockRejectedValueOnce(error)
  await expect(acquireHomeOwnership(home)).rejects.toBe(error)
})

it('propagates candidate rename failures without an error code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-rename-unknown-'))
  roots.push(root)
  const home = join(root, 'home')
  const error = new Error('rename failed without a code')
  vi.mocked(fs.rename).mockRejectedValueOnce(error)
  await expect(acquireHomeOwnership(home)).rejects.toBe(error)
})

it('propagates an owner-read failure after a competing rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-read-failure-'))
  roots.push(root)
  const home = join(root, 'home')
  const error = Object.assign(new Error('owner read refused'), { code: 'EACCES' })
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('lease exists'), { code: 'EEXIST' }))
  vi.mocked(fs.readdir).mockRejectedValueOnce(error)
  await expect(acquireHomeOwnership(home)).rejects.toBe(error)
})

it('retries after a lease disappears during owner read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-read-race-'))
  roots.push(root)
  const home = join(root, 'home')
  const lease = join(home, 'runtime', 'instance.lease')
  await mkdir(lease, { recursive: true })
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('lease exists'), { code: 'EEXIST' }))
  vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error('lease vanished'), { code: 'ENOENT' }))
  const owner = await acquireHomeOwnership(home)
  await owner.release()
})

it('retries after a Windows lease read reports EPERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-windows-read-race-'))
  roots.push(root)
  const home = join(root, 'home')
  const lease = join(home, 'runtime', 'instance.lease')
  await mkdir(lease, { recursive: true })
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('lease exists'), { code: 'EEXIST' }))
  vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error('lease locked'), { code: 'EPERM' }))
  const owner = await acquireHomeOwnership(home)
  await owner.release()
})

it('propagates unexpected release directory removal failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-release-failure-'))
  roots.push(root)
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  const error = Object.assign(new Error('directory removal refused'), { code: 'EACCES' })
  vi.mocked(fs.rmdir).mockRejectedValueOnce(error)
  await expect(owner.release()).rejects.toBe(error)
})

it('propagates release directory removal failures without an error code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-release-unknown-'))
  roots.push(root)
  const home = join(root, 'home')
  const owner = await acquireHomeOwnership(home)
  const error = new Error('directory removal failed without a code')
  vi.mocked(fs.rmdir).mockRejectedValueOnce(error)
  await expect(owner.release()).rejects.toBe(error)
})

it('propagates stale-owner removal failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-stale-removal-'))
  roots.push(root)
  const home = join(root, 'home')
  const lease = join(home, 'runtime', 'instance.lease')
  const nonce = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  await mkdir(lease, { recursive: true })
  await writeFile(join(lease, `owner-${nonce}.json`), JSON.stringify({ pid: 2_147_483_647, nonce }))
  const error = Object.assign(new Error('stale owner removal refused'), { code: 'EACCES' })
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.rm).mockImplementation(async (path, options) => {
    if (String(path).endsWith(`owner-${nonce}.json`)) throw error
    return actual.rm(path, options)
  })
  await expect(acquireHomeOwnership(home)).rejects.toBe(error)
})

it('propagates stale-owner removal failures without an error code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-stale-unknown-'))
  roots.push(root)
  const home = join(root, 'home')
  const lease = join(home, 'runtime', 'instance.lease')
  const nonce = 'cccccccccccccccccccccccccccccccc'
  await mkdir(lease, { recursive: true })
  await writeFile(join(lease, `owner-${nonce}.json`), JSON.stringify({ pid: 2_147_483_647, nonce }))
  const error = new Error('stale owner removal failed without a code')
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.rm).mockImplementation(async (path, options) => {
    if (String(path).endsWith(`owner-${nonce}.json`)) throw error
    return actual.rm(path, options)
  })
  await expect(acquireHomeOwnership(home)).rejects.toBe(error)
})

it('continues when a stale owner file has already disappeared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-stale-enoent-'))
  roots.push(root)
  const home = join(root, 'home')
  const lease = join(home, 'runtime', 'instance.lease')
  const nonce = 'dddddddddddddddddddddddddddddddd'
  await mkdir(lease, { recursive: true })
  await writeFile(join(lease, `owner-${nonce}.json`), JSON.stringify({ pid: 2_147_483_647, nonce }))
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let missing = true
  vi.mocked(fs.rm).mockImplementation(async (path, options) => {
    if (missing && String(path).endsWith(`owner-${nonce}.json`)) {
      missing = false
      throw Object.assign(new Error('owner already removed'), { code: 'ENOENT' })
    }
    return actual.rm(path, options)
  })
  const owner = await acquireHomeOwnership(home)
  await owner.release()
})

it('propagates stale-lease directory removal failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-stale-rmdir-'))
  roots.push(root)
  const home = join(root, 'home')
  const lease = join(home, 'runtime', 'instance.lease')
  const nonce = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  await mkdir(lease, { recursive: true })
  await writeFile(join(lease, `owner-${nonce}.json`), JSON.stringify({ pid: 2_147_483_647, nonce }))
  const error = new Error('stale lease removal refused')
  vi.mocked(fs.rmdir).mockRejectedValueOnce(error)
  await expect(acquireHomeOwnership(home)).rejects.toBe(error)
})

it('continues when a stale lease directory has already disappeared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-owner-stale-rmdir-enoent-'))
  roots.push(root)
  const home = join(root, 'home')
  const lease = join(home, 'runtime', 'instance.lease')
  const nonce = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  await mkdir(lease, { recursive: true })
  await writeFile(join(lease, `owner-${nonce}.json`), JSON.stringify({ pid: 2_147_483_647, nonce }))
  vi.mocked(fs.rmdir).mockRejectedValueOnce(Object.assign(new Error('lease already removed'), { code: 'ENOENT' }))
  const owner = await acquireHomeOwnership(home)
  await owner.release()
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
