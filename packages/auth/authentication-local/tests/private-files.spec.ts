import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const renameFailure = vi.hoisted(() => ({ destination: undefined as string | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (source: string, destination: string): Promise<void> => {
      if (destination === renameFailure.destination) {
        renameFailure.destination = undefined
        throw Object.assign(new Error('simulated Windows lock collision'), { code: 'EPERM' })
      }
      await actual.rename(source, destination)
    },
  }
})

import { withPrivateFileLock } from '../src/private-files.ts'

const roots: string[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(async () => {
  renameFailure.destination = undefined
  Object.defineProperty(process, 'platform', platformDescriptor)
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe('private file writer lock portability', () => {
  it('retries the EPERM collision reported by Windows directory rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-private-lock-windows-'))
    roots.push(root)
    const target = join(root, 'value.json')
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
    renameFailure.destination = `${target}.lock`

    await expect(withPrivateFileLock(target, async () => 42)).resolves.toBe(42)
  })

  it('does not hide EPERM away from Windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-private-lock-posix-'))
    roots.push(root)
    const target = join(root, 'value.json')
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' })
    renameFailure.destination = `${target}.lock`

    await expect(withPrivateFileLock(target, async () => 42)).rejects.toMatchObject({ code: 'EPERM' })
  })
})
