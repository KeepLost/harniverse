/**
 * Real two-process write-lease contention over one shared root: a child Node
 * process holds the session's kernel write lock (a raw `flock` through the C
 * library); this process's backend is excluded while the child lives, and its
 * next append commits immediately after a SIGKILL — the kernel releases the
 * lock with the dead process's descriptors, no waiting period. Keyless.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '../src/index.ts'
import { sessionDir } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const HOLDER = fileURLToPath(new URL('./fixtures/lease-holder.mjs', import.meta.url))
const SESSION = SessionId('two-process-lease')

function continuation(base: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: base, time: base + 1, data: { turn: 2 } },
    { type: 'turn/end', seq: base + 1, time: base + 2, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

describe('two-process write lease', () => {
  it.skipIf(process.platform !== 'linux')('excludes a live holder process and takes over immediately after its crash', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-lease-2proc-'))
    dirs.push(root)

    // Materialize the session, then release this process's lease so the child
    // can take over the same session directory.
    const author = new Context()
    contexts.push(author)
    await author.plugin(SessionStore)
    await author.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const writer = author.sessionPersistence
    await writer.create(meta('two-process-lease', '/work'))
    const events = oneTurnLog()
    await writer.append(SESSION, events)
    const authorIndex = contexts.indexOf(author)
    const [authorContext] = contexts.splice(authorIndex, 1)
    if (authorContext === undefined) throw new Error('author context missing')
    await authorContext.fiber.dispose()

    const holder = spawn(process.execPath, [HOLDER, sessionDir(root, '/work', SESSION)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = new Promise<void>((resolve) => { holder.once('exit', () => { resolve() }) })
    try {
      await once(holder.stdout, 'data') // 'holding'

      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      const mine: SessionPersistence = ctx.sessionPersistence

      // Excluded while the other process's descriptor holds the kernel lock.
      await expect(mine.append(SESSION, continuation(events.length)))
        .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      // Reads stay unaffected across processes.
      const loaded = await mine.load(SESSION)
      expect(loaded.events.map(event => event.seq)).toEqual(events.map(event => event.seq))

      // Crash the holder: no release runs, but the kernel drops the lock with
      // the process, so the takeover commits without any waiting period.
      holder.kill('SIGKILL')
      await exited
      await expect(mine.append(SESSION, continuation(events.length))).resolves.toBeUndefined()
      const reloaded = await mine.load(SESSION)
      expect(reloaded.events.map(event => event.seq)).toHaveLength(events.length + 2)
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL')
    }
  })
})
