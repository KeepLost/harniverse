/**
 * Owner-only file and writer-lock failure paths: broad POSIX permissions,
 * temporary-file cleanup, and stale, foreign, or malformed writer locks.
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const failures = vi.hoisted(() => ({
  renameDestination: undefined as { destination: string; code: string } | undefined,
  rmdirPath: undefined as { path: string; code: string; once: boolean; plant?: string } | undefined,
  rmPrefix: undefined as string | undefined,
  statMode: undefined as { path: string; mode: number } | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (source: string, destination: string): Promise<void> => {
      if (destination === failures.renameDestination?.destination) {
        const { code } = failures.renameDestination
        failures.renameDestination = undefined
        throw Object.assign(new Error('simulated rename failure'), { code })
      }
      await actual.rename(source, destination)
    },
    rmdir: async (path: string): Promise<void> => {
      const failure = failures.rmdirPath
      if (failure && failure.path === path) {
        if (failure.once) failures.rmdirPath = undefined
        if (failure.plant !== undefined) {
          await actual.writeFile(join(path, `owner-${failure.plant}.json`),
            `${JSON.stringify({ pid: process.pid, nonce: failure.plant })}\n`, { mode: 0o600 })
        }
        throw Object.assign(new Error('simulated rmdir failure'), { code: failure.code })
      }
      await actual.rmdir(path)
    },
    rm: async (path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> => {
      if (failures.rmPrefix !== undefined && path.startsWith(`${failures.rmPrefix}${sep}`)) return
      await actual.rm(path, options)
    },
    stat: async (...args: Parameters<typeof actual.stat>): Promise<ReturnType<typeof actual.stat>> => {
      if (failures.statMode !== undefined && String(args[0]) === failures.statMode.path) {
        const info = await actual.stat(...args)
        Object.defineProperty(info, 'mode', { value: failures.statMode.mode })
        return info
      }
      return await actual.stat(...args)
    },
  }
})

import {
  assertPrivateFile,
  ensurePrivateDirectory,
  isProcessAlive,
  withPrivateFileLock,
  writePrivateFile,
} from '../src/private-files.ts'

const roots: string[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(async () => {
  failures.renameDestination = undefined
  failures.rmdirPath = undefined
  failures.rmPrefix = undefined
  failures.statMode = undefined
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.restoreAllMocks()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function prepare(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-private-lifecycle-'))
  roots.push(root)
  return root
}

/** A nonce-shaped hex string distinct per seed character. */
function hex(seed: string): string {
  return seed.repeat(32)
}

async function craftLock(lockPath: string, owner: { pid: number; nonce: string }): Promise<void> {
  await mkdir(lockPath, { mode: 0o700 })
  await writeFile(join(lockPath, `owner-${owner.nonce}.json`),
    `${JSON.stringify(owner)}\n`, { mode: 0o600 })
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  return child.pid!
}

describe('private file permission guards', () => {
  it('treats an unsignalable pid as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('simulated EPERM'), { code: 'EPERM' })
    })
    expect(isProcessAlive(1234)).toBe(true)
  })

  it('rejects directories readable beyond their owner', async () => {
    const root = await prepare()
    const dir = join(root, 'store')
    await mkdir(dir, { mode: 0o755 })
    await chmod(dir, 0o755)
    if (process.platform === 'win32') {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
      failures.statMode = { path: dir, mode: 0o755 }
    }
    await expect(ensurePrivateDirectory(dir)).rejects.toThrow('accessible beyond its owner')
  })

  it('skips private file checks on Windows', async () => {
    const root = await prepare()
    const file = join(root, 'value.json')
    await writeFile(file, 'x')
    await chmod(file, 0o644)
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
    await expect(assertPrivateFile(file)).resolves.toBeUndefined()
  })

  it('removes the temporary file when the final rename fails', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    failures.renameDestination = { destination: target, code: 'EACCES' }
    await expect(writePrivateFile(target, 'content')).rejects.toMatchObject({ code: 'EACCES' })
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('writer lock validation', () => {
  it('rejects a lock directory holding two owner files', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await craftLock(lockPath, { pid: process.pid, nonce: hex('a') })
    await writeFile(join(lockPath, `owner-${hex('b')}.json`),
      `${JSON.stringify({ pid: process.pid, nonce: hex('b') })}\n`, { mode: 0o600 })
    await expect(withPrivateFileLock(target, async () => 42)).rejects.toThrow('invalid writer lock')
  })

  it('rejects an owner record without a nonce', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await mkdir(lockPath, { mode: 0o700 })
    await writeFile(join(lockPath, `owner-${hex('a')}.json`), `${JSON.stringify({ pid: 1 })}\n`, { mode: 0o600 })
    await expect(withPrivateFileLock(target, async () => 42)).rejects.toThrow('invalid writer lock')
  })

  it('rejects an owner file whose name does not match its nonce', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await mkdir(lockPath, { mode: 0o700 })
    await writeFile(join(lockPath, `owner-${hex('a')}.json`),
      `${JSON.stringify({ pid: 5, nonce: hex('b') })}\n`, { mode: 0o600 })
    await expect(withPrivateFileLock(target, async () => 42)).rejects.toThrow('invalid writer lock')
  })

  it('times out when a live process keeps the lock', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    await craftLock(`${target}.lock`, { pid: process.pid, nonce: hex('d') })
    vi.spyOn(Date, 'now').mockImplementationOnce(() => 0).mockImplementation(() => 100_000)
    await expect(withPrivateFileLock(target, async () => 'never'))
      .rejects.toThrow('timed out waiting for writer lock')
  })
})

describe('stale writer lock reclamation', () => {
  it('reclaims the lock of a dead process', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await craftLock(lockPath, { pid: await deadPid(), nonce: hex('c') })
    await expect(withPrivateFileLock(target, async () => 'reclaimed')).resolves.toBe('reclaimed')
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('tolerates a lock directory that stayed non-empty during reclamation', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await craftLock(lockPath, { pid: await deadPid(), nonce: hex('c') })
    failures.rmdirPath = { path: lockPath, code: 'ENOTEMPTY', once: true }
    await expect(withPrivateFileLock(target, async () => 'reclaimed')).resolves.toBe('reclaimed')
  })

  it('tolerates a lock directory that vanished during reclamation', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await craftLock(lockPath, { pid: await deadPid(), nonce: hex('c') })
    failures.rmdirPath = { path: lockPath, code: 'ENOENT', once: true }
    await expect(withPrivateFileLock(target, async () => 'reclaimed')).resolves.toBe('reclaimed')
  })

  it('reclaims a torn lock directory whose owner file has vanished', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await mkdir(lockPath, { mode: 0o700 })
    failures.renameDestination = { destination: lockPath, code: 'EEXIST' }
    await expect(withPrivateFileLock(target, async () => 'reclaimed')).resolves.toBe('reclaimed')
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('times out when a torn lock directory cannot be cleared', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await mkdir(lockPath, { mode: 0o700 })
    await writeFile(join(lockPath, 'stray.txt'), 'debris')
    failures.renameDestination = { destination: lockPath, code: 'EEXIST' }
    failures.rmdirPath = { path: lockPath, code: 'ENOTEMPTY', once: false }
    vi.spyOn(Date, 'now').mockImplementationOnce(() => 0).mockImplementationOnce(() => 1_000).mockImplementation(() => 100_000)
    await expect(withPrivateFileLock(target, async () => 'never'))
      .rejects.toThrow('timed out waiting for writer lock')
  })

  it('surfaces torn-lock clearing failures', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await mkdir(lockPath, { mode: 0o700 })
    failures.renameDestination = { destination: lockPath, code: 'EEXIST' }
    failures.rmdirPath = { path: lockPath, code: 'EACCES', once: false }
    await expect(withPrivateFileLock(target, async () => 'never')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('surfaces lock directory removal failures during reclamation', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await craftLock(lockPath, { pid: await deadPid(), nonce: hex('c') })
    failures.rmdirPath = { path: lockPath, code: 'EACCES', once: true }
    await expect(withPrivateFileLock(target, async () => 'reclaimed')).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('writer lock release', () => {
  it('leaves a replaced foreign writer lock untouched', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await expect(withPrivateFileLock(target, async () => {
      const [mine] = (await readdir(lockPath)).filter(name => name.startsWith('owner-'))
      await rm(join(lockPath, mine!), { force: true })
      await writeFile(join(lockPath, `owner-${hex('e')}.json`),
        `${JSON.stringify({ pid: process.pid, nonce: hex('e') })}\n`, { mode: 0o600 })
      return 'done'
    })).resolves.toBe('done')
    expect((await stat(lockPath)).isDirectory()).toBe(true)
  })

  it('propagates lock directory removal failures at release', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    failures.rmdirPath = { path: `${target}.lock`, code: 'EACCES', once: true }
    await expect(withPrivateFileLock(target, async () => 'done')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('keeps a writer lock a racing process already replaced', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    failures.rmdirPath = { path: lockPath, code: 'ENOTEMPTY', once: true, plant: hex('f') }
    await expect(withPrivateFileLock(target, async () => 'done')).resolves.toBe('done')
    await expect(readdir(lockPath)).resolves.toEqual([`owner-${hex('f')}.json`])
  })

  it('reports a removal race the same process still owns', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    failures.rmPrefix = lockPath
    await expect(withPrivateFileLock(target, async () => 'done'))
      .rejects.toMatchObject({ code: 'ENOTEMPTY' })
  })

  it('tolerates the writer lock vanishing before release', async () => {
    const root = await prepare()
    const target = join(root, 'value.json')
    const lockPath = `${target}.lock`
    await expect(withPrivateFileLock(target, async () => {
      await rm(lockPath, { recursive: true, force: true })
      return 'done'
    })).resolves.toBe('done')
  })
})
