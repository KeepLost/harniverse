/**
 * Database file creation faults. The pre-creation step exists to fix the file
 * mode before SQLite opens it, so a failure other than "already exists" must
 * propagate rather than leaving the store to open a file it never secured.
 * This needs an injected fault: the surrounding validation already refuses
 * every condition a real filesystem could present at this point.
 */

import { mkdtemp, open as realOpen, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'

const faults = vi.hoisted(() => ({
  /** errno raised by an exclusive create of a path ending with this suffix. */
  createCode: undefined as string | undefined,
  createSuffix: '',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const exclusive = String(args[1] ?? '') === 'wx'
      if (faults.createCode !== undefined && exclusive && String(args[0]).endsWith(faults.createSuffix)) {
        throw Object.assign(new Error(`simulated ${faults.createCode}`), { code: faults.createCode })
      }
      return await actual.open(...args)
    },
  }
})

const { default: SqliteSessionPersistence } = await import('../src/index.ts')

const roots: string[] = []

afterEach(async () => {
  faults.createCode = undefined
  faults.createSuffix = ''
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-create-'))
  roots.push(root)
  return join(root, 'sessions.db')
}

describe('database file pre-creation', () => {
  it('propagates a create failure that is not an existing file', async () => {
    const path = await databasePath()
    faults.createCode = 'EACCES'
    faults.createSuffix = 'sessions.db'
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SqliteSessionPersistence, { path })

    await expect(ctx.sessionPersistence.list()).rejects.toMatchObject({ code: 'EACCES' })
    await fiber.dispose()
  })

  it('accepts a database file another process created first', async () => {
    const path = await databasePath()
    // The file is really there, as it would be after a concurrent creator won.
    const seeded = await realOpen(path, 'wx', 0o600)
    await seeded.close()
    faults.createCode = 'EEXIST'
    faults.createSuffix = 'sessions.db'
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SqliteSessionPersistence, { path })

    // A concurrent creator already made the file; its mode is that creator's
    // responsibility and the store proceeds to open it.
    await expect(ctx.sessionPersistence.list()).resolves.toEqual([])
    await fiber.dispose()
  })
})
