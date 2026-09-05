/**
 * Shutdown containment: a registry refresh queued behind an in-flight reload
 * is skipped once the service has closed, so disposal never re-arms state.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeWatcher {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  closed = false

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

const watchers: FakeWatcher[] = []

vi.mock('chokidar', () => ({
  watch: () => {
    const watcher = new FakeWatcher()
    watchers.push(watcher)
    return watcher
  },
}))

const gate = vi.hoisted(() => ({
  reads: 0,
  armed: false,
  release: (): void => {},
}))

vi.mock('../src/grant-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/grant-registry.ts')>()
  return {
    ...actual,
    readGrantRegistry: async (...args: Parameters<typeof actual.readGrantRegistry>) => {
      gate.reads += 1
      if (gate.armed) {
        gate.armed = false
        await new Promise<void>((resolve) => { gate.release = resolve })
      }
      return actual.readGrantRegistry(...args)
    },
  }
})

const { default: LocalAuthentication } = await import('../src/index.ts')
const { createGrantFixture } = await import('./grant-fixture.ts')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  gate.reads = 0
  gate.armed = false
  watchers.length = 0
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('registry refresh shutdown containment', () => {
  it('skips a refresh queued behind an in-flight reload once closed', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-auth-refresh-'))
    cleanups.push(() => rm(dshHome, { recursive: true, force: true }))
    await createGrantFixture(dshHome, 'owner')
    const ctx = new Context()
    const fiber = ctx.plugin(LocalAuthentication, { dshHome, mode: 'authenticated', watch: true, debounceMs: 1 })
    await fiber
    const watcher = watchers.at(-1)
    if (watcher === undefined) throw new Error('expected a registry watcher')
    const bootReads = gate.reads

    gate.armed = true
    watcher.emit('all', 'change', `${dshHome}/registry.json`)
    await vi.waitFor(() => { expect(gate.reads).toBe(bootReads + 1) })
    watcher.emit('all', 'change', `${dshHome}/registry.json`)

    const disposed = fiber.dispose()
    await vi.waitFor(() => { expect(watcher.closed).toBe(true) })
    gate.release()
    await disposed

    expect(gate.reads).toBe(bootReads + 1)
  })
})
