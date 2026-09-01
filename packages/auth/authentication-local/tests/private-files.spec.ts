import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const failures = vi.hoisted(() => ({
  renameDestination: undefined as string | undefined,
  emulatePrivatePosixMode: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (source: string, destination: string): Promise<void> => {
      if (destination === failures.renameDestination) {
        failures.renameDestination = undefined
        throw Object.assign(new Error('simulated Windows lock collision'), { code: 'EPERM' })
      }
      await actual.rename(source, destination)
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const info = await actual.stat(...args)
      if (failures.emulatePrivatePosixMode && typeof info.mode === 'number') info.mode &= ~0o077
      return info
    },
  }
})

import { withPrivateFileLock } from '../src/private-files.ts'

const roots: string[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(async () => {
  failures.renameDestination = undefined
  failures.emulatePrivatePosixMode = false
  Object.defineProperty(process, 'platform', platformDescriptor)
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe('private file writer lock portability', () => {
  it('retries the EPERM collision reported by Windows directory rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-private-lock-windows-'))
    roots.push(root)
    const target = join(root, 'value.json')
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
    failures.renameDestination = `${target}.lock`

    await expect(withPrivateFileLock(target, async () => 42)).resolves.toBe(42)
  })

  it('does not hide EPERM away from Windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-private-lock-posix-'))
    roots.push(root)
    const target = join(root, 'value.json')
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' })
    failures.emulatePrivatePosixMode = true
    failures.renameDestination = `${target}.lock`

    await expect(withPrivateFileLock(target, async () => 42)).rejects.toMatchObject({ code: 'EPERM' })
  })
})
