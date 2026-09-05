/**
 * Ownership-validation arms of the database open path. Windows hosts have no
 * `process.getuid`, so the uid guards never evaluate there natively; these
 * tests inject an effective identity and scripted lstat facts so every arm
 * runs on every host.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'

const OWNED_UID = 41_000

const faults = vi.hoisted(() => ({
  parentPath: undefined as string | undefined,
  parentFacts: undefined as { uid: number; mode: number } | undefined,
  filePath: undefined as string | undefined,
  fileFacts: undefined as { uid: number; mode: number } | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0])
      const facts = path === faults.parentPath
        ? faults.parentFacts
        : path === faults.filePath ? faults.fileFacts : undefined
      const info = await actual.lstat(...args)
      if (facts !== undefined) {
        Object.defineProperty(info, 'uid', { value: facts.uid })
        Object.defineProperty(info, 'mode', { value: facts.mode })
      }
      return info
    }),
  }
})

const { default: SqliteSessionPersistence } = await import('../src/index.ts')

const roots: string[] = []
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid')

afterEach(async () => {
  faults.parentPath = undefined
  faults.parentFacts = undefined
  faults.filePath = undefined
  faults.fileFacts = undefined
  if (getuidDescriptor !== undefined) {
    Object.defineProperty(process, 'getuid', getuidDescriptor)
  } else {
    Reflect.deleteProperty(process, 'getuid')
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function mockEffectiveUser(): void {
  Object.defineProperty(process, 'getuid', { value: () => OWNED_UID, configurable: true })
}

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-owner-'))
  roots.push(root)
  return join(root, 'sessions.db')
}

async function rejectsWith(
  path: string,
  message: RegExp,
): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SqliteSessionPersistence, { path })
  await expect(ctx.sessionPersistence.list()).rejects.toThrow(message)
  await fiber.dispose()
}

describe('database ownership validation', () => {
  it('rejects a database parent owned by another principal', async () => {
    const path = await databasePath()
    mockEffectiveUser()
    faults.parentPath = dirname(resolve(path))
    faults.parentFacts = { uid: OWNED_UID + 1, mode: 0o040700 }

    await rejectsWith(path, /must be owned by the current user and not group\/world-writable/)
  })

  it('rejects a group-writable database parent under the current identity', async () => {
    const path = await databasePath()
    mockEffectiveUser()
    faults.parentPath = dirname(resolve(path))
    faults.parentFacts = { uid: OWNED_UID, mode: 0o040770 }

    await rejectsWith(path, /must be owned by the current user and not group\/world-writable/)
  })

  it('rejects a database file owned by another principal', async () => {
    const path = await databasePath()
    mockEffectiveUser()
    faults.parentPath = dirname(resolve(path))
    faults.parentFacts = { uid: OWNED_UID, mode: 0o040700 }
    faults.filePath = resolve(path)
    faults.fileFacts = { uid: OWNED_UID + 1, mode: 0o100600 }

    await rejectsWith(path, /must be owned by the current user and accessible only by that user/)
  })

  it('rejects a database file accessible to another principal under the current identity', async () => {
    const path = await databasePath()
    mockEffectiveUser()
    faults.parentPath = dirname(resolve(path))
    faults.parentFacts = { uid: OWNED_UID, mode: 0o040700 }
    faults.filePath = resolve(path)
    faults.fileFacts = { uid: OWNED_UID, mode: 0o100640 }

    await rejectsWith(path, /must be owned by the current user and accessible only by that user/)
  })
})
