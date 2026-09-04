/**
 * Access-log failure propagation: the rotation and size probes tolerate a
 * missing file, because a competing writer may have rotated first, but every
 * other filesystem failure must surface instead of silently restarting the log.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const failures = vi.hoisted(() => ({
  /**
   * Error raised by the size probe of the active access log. The privacy
   * assertion stats the same path first, so that call is allowed through.
   */
  statError: undefined as NodeJS.ErrnoException | undefined,
  statCalls: 0,
  /** Error raised when a rotated generation is shifted. */
  shiftError: undefined as NodeJS.ErrnoException | undefined,
  /** Error raised when the active file is moved to generation 1. */
  promoteError: undefined as NodeJS.ErrnoException | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const isAccessLog = (path: unknown): boolean => String(path).endsWith('access.jsonl')
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (failures.statError !== undefined && isAccessLog(args[0])) {
        failures.statCalls += 1
        // The privacy assertion probes the same path first; only the size
        // probe that follows it carries the injected failure.
        if (failures.statCalls > 1) {
          const error = failures.statError
          failures.statError = undefined
          throw error
        }
      }
      return await actual.stat(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const source = String(args[0])
      if (failures.promoteError !== undefined && isAccessLog(source)) {
        const error = failures.promoteError
        failures.promoteError = undefined
        throw error
      }
      if (failures.shiftError !== undefined && /access\.jsonl\.\d+$/.test(source)) {
        const error = failures.shiftError
        failures.shiftError = undefined
        throw error
      }
      await actual.rename(...args)
    },
  }
})

const { appendAccessRecord, accessLogPath } = await import('../src/access-log.ts')

const homes: string[] = []

afterEach(async () => {
  failures.statError = undefined
  failures.statCalls = 0
  failures.shiftError = undefined
  failures.promoteError = undefined
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-auth-log-failure-'))
  homes.push(value)
  return value
}

const started = { time: '2026-08-16T00:00:00.000Z', event: 'instance-started' } as const
const stopped = { time: '2026-08-16T00:00:01.000Z', event: 'instance-stopped' } as const

/** A byte bound that admits exactly one record, so the next append rotates. */
const oneRecord = Buffer.byteLength(`${JSON.stringify(started)}\n`)

const ioError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`simulated ${code}`), { code })

describe('access log failure propagation', () => {
  it('propagates a non-missing failure from the size probe', async () => {
    const dshHome = await home()
    await appendAccessRecord(started, { dshHome })
    failures.statError = ioError('EIO')

    await expect(appendAccessRecord(stopped, { dshHome })).rejects.toMatchObject({ code: 'EIO' })
  })

  it('treats a missing active file as an empty log', async () => {
    const dshHome = await home()
    failures.statError = ioError('ENOENT')

    // A competing writer may have rotated between the lock and the probe.
    await expect(appendAccessRecord(started, { dshHome })).resolves.toBeUndefined()
    expect(await readFile(accessLogPath(dshHome), 'utf8')).toContain('instance-started')
  })

  it('propagates a non-missing failure while shifting a rotated generation', async () => {
    const dshHome = await home()
    const path = accessLogPath(dshHome)
    // Establish generation 1 so the next rotation has something to shift.
    await appendAccessRecord(started, { dshHome, maxBytes: oneRecord, maxFiles: 3 })
    await appendAccessRecord(stopped, { dshHome, maxBytes: oneRecord, maxFiles: 3 })
    expect(await readFile(`${path}.1`, 'utf8')).toContain('instance-started')
    failures.shiftError = ioError('EACCES')

    await expect(appendAccessRecord(started, { dshHome, maxBytes: oneRecord, maxFiles: 3 }))
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('propagates a non-missing failure while promoting the active file', async () => {
    const dshHome = await home()
    await appendAccessRecord(started, { dshHome, maxBytes: oneRecord, maxFiles: 2 })
    failures.promoteError = ioError('EBUSY')

    await expect(appendAccessRecord(stopped, { dshHome, maxBytes: oneRecord, maxFiles: 2 }))
      .rejects.toMatchObject({ code: 'EBUSY' })
  })

  it('tolerates an active file that vanishes before promotion', async () => {
    const dshHome = await home()
    const path = accessLogPath(dshHome)
    await appendAccessRecord(started, { dshHome, maxBytes: oneRecord, maxFiles: 2 })
    failures.promoteError = ioError('ENOENT')

    // Another writer rotated first; this rotation has nothing left to move.
    await expect(appendAccessRecord(stopped, { dshHome, maxBytes: oneRecord, maxFiles: 2 }))
      .resolves.toBeUndefined()
    expect(await readFile(path, 'utf8')).toContain('instance-stopped')
  })
})
