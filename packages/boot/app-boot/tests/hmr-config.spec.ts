import { EventEmitter } from 'node:events'
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import fsPromises, { realpath } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Hmr from '@deepseek-ai/cordis-plugin-hmr'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { describe, expect, it, vi } from 'vitest'

async function bootHmr(dir: string, root: string[] = [], options: Pick<Hmr.Config, 'usePolling' | 'interval'> = {}): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, {
    root,
    ignored: [],
    debounce: 0,
    ...options,
  })
  return ctx
}

async function eventually(test: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('HMR exact config paths', () => {
  it('observes module changes when its watch base is a filesystem alias', { timeout: 30_000 }, async () => {
    const target = mkdtempSync(join(tmpdir(), 'dsh-hmr-module-canonical-'))
    const alias = `${target}-alias`
    const aliasFilename = join(alias, 'module.ts')
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(aliasFilename, 'export const generation = 0\n')
    // This acceptance owns alias-to-cache identity. Chokidar polling keeps
    // Windows fs.watch queue pressure out of the module-watcher test.
    const ctx = await bootHmr(alias, ['.'], { usePolling: true })
    const filename = join(await realpath(target), 'module.ts')
    const expected = pathToFileURL(filename).href
    const cacheHas = vi.spyOn(ctx.loader.internal!.loadCache, 'has').mockReturnValue(false)
    const observed: string[] = []
    ctx.on('hmr/change', (url) => { observed.push(url) })
    try {
      const deadline = Date.now() + 20_000
      for (let generation = 1; !observed.includes(expected); generation += 1) {
        if (Date.now() >= deadline) {
          throw new Error(`HMR did not observe ${expected} through the alias; observed ${JSON.stringify(observed)}`)
        }
        // The watch base, not the writer spelling, is the alias under test.
        // Grow the file on every write: polling must not depend on timestamp
        // precision when several generations land inside one filesystem tick.
        writeFileSync(filename, `export const generation = ${generation}\n${' '.repeat(generation)}\n`)
        // Leave Chokidar's atomic-write window idle so one coalesced change can publish.
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      expect(cacheHas).toHaveBeenCalledWith(expected)
    } finally {
      await ctx.fiber.dispose()
      unlinkSync(alias)
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('collapses filesystem aliases before registering an exact watch', async () => {
    const target = mkdtempSync(join(tmpdir(), 'dsh-hmr-canonical-'))
    const alias = `${target}-alias`
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const ctx = await bootHmr(alias)
    try {
      const canonical = join(await realpath(target), 'plugins.yml')
      const registrations = await Promise.allSettled([
        ctx.hmr.registerConfig('plugins.yml', () => {}),
        ctx.hmr.registerConfig(canonical, () => {}),
      ])
      expect(registrations.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(registrations.find(result => result.status === 'rejected')?.reason)
        .toHaveProperty('message', expect.stringContaining('config path already registered'))
    } finally {
      await ctx.fiber.dispose()
      unlinkSync(alias)
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('observes add, change, and unlink outside its module roots', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    const observed: string[] = []
    try {
      await ctx.hmr.registerConfig(filename, () => {
        try {
          observed.push(readFileSync(filename, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          observed.push('missing')
        }
      })

      writeFileSync(filename, 'one', { flag: 'wx' })
      await eventually(() => observed.includes('one'), 'HMR did not observe config creation')
      writeFileSync(filename, 'two')
      await eventually(() => observed.includes('two'), 'HMR did not observe config change')
      unlinkSync(filename)
      await eventually(() => observed.includes('missing'), 'HMR did not observe config removal')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('observes creation when the config parent did not exist at registration', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    const dir = join(root, 'later')
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(root)
    const observed: string[] = []
    try {
      await ctx.hmr.registerConfig(filename, () => {
        observed.push(readFileSync(filename, 'utf8'))
      })
      mkdirSync(dir)
      writeFileSync(filename, 'created')
      await eventually(() => observed.includes('created'), 'HMR did not observe config creation under a new parent')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('observes a single creation across native watcher startup', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-startup-'))
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    const observed: string[] = []
    const startNative: Array<() => void> = []
    const fsWatch = fs.watch
    const watch = vi.spyOn(fs, 'watch').mockImplementation((...args: Parameters<typeof fs.watch>) => {
      let native: fs.FSWatcher | undefined
      const handle: fs.FSWatcher = Object.assign(new EventEmitter(), {
        close() { native?.close() },
        ref(): fs.FSWatcher { native?.ref(); return handle },
        unref(): fs.FSWatcher { native?.unref(); return handle },
      })
      // fs.watch can return before macOS installs its native subscription.
      startNative.push(() => {
        native = fsWatch(...args)
        native.on('error', error => handle.emit('error', error))
      })
      return handle
    })
    syncBuiltinESMExports()
    try {
      await ctx.hmr.registerConfig(filename, () => { observed.push(readFileSync(filename, 'utf8')) })
      writeFileSync(filename, 'one', { flag: 'wx' })
      for (const start of startNative) start()
      await eventually(() => observed.includes('one'), 'HMR lost the only creation during native startup')
    } finally {
      await ctx.fiber.dispose()
      watch.mockRestore()
      syncBuiltinESMExports()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serializes refreshes and waits for them during disposal', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    const filename = join(dir, 'plugins.yml')
    writeFileSync(filename, 'one')
    const ctx = await bootHmr(dir)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observed: string[] = []
    let active = 0
    let maxActive = 0
    try {
      const dispose = await ctx.hmr.registerConfig(filename, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        observed.push(readFileSync(filename, 'utf8'))
        if (observed.length === 1) {
          started.resolve(undefined)
          await release.promise
        }
        active -= 1
      })
      await started.promise
      writeFileSync(filename, 'two')
      const current = await fsPromises.stat(filename, { bigint: true })
      vi.spyOn(fsPromises, 'stat').mockResolvedValue(current)
      syncBuiltinESMExports()
      await vi.advanceTimersByTimeAsync(100)

      let disposed = false
      const disposal = dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await disposal
      expect(maxActive).toBe(1)
      expect(observed).toEqual(['one', 'two'])
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes refresh failures and broadcasts them without escaping the watcher', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    const failure = Promise.withResolvers<{ filename: string; error: Error }>()
    let failureCount = 0
    try {
      ctx.on('hmr/config-update-failed', () => {
        throw new Error('observer failed')
      })
      ctx.on('hmr/config-update-failed', (failedFilename, error) => {
        failureCount += 1
        failure.resolve({ filename: failedFilename, error })
      })
      await ctx.hmr.registerConfig(filename, () => { throw 42 })
      writeFileSync(filename, 'invalid')

      const observed = await failure.promise
      expect(observed.filename).toBe(filename)
      expect(observed.error).toBeInstanceOf(Error)
      expect(observed.error.message).toBe('42')

      writeFileSync(filename, 'invalid again')
      await eventually(() => failureCount === 2, 'HMR stopped broadcasting after an observer rejected')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refreshes an existing exact path once and detects stat changes after read errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-snapshots-'))
    const filename = join(dir, 'plugins.yml')
    writeFileSync(filename, 'one')
    let current = await fsPromises.stat(filename, { bigint: true })
    const ctx = await bootHmr(dir)
    const observed: string[] = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await ctx.hmr.registerConfig(filename, () => { observed.push(readFileSync(filename, 'utf8')) })
      const stat = vi.spyOn(fsPromises, 'stat').mockImplementation(async () => current)
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      syncBuiltinESMExports()
      writeFileSync(join(dir, 'unrelated.yml'), 'other')
      current = { ...current, atimeNs: current.atimeNs + 1n }
      await vi.advanceTimersByTimeAsync(300)
      expect(observed).toEqual(['one'])
      expect(stat).toHaveBeenLastCalledWith(join(await realpath(dir), 'plugins.yml'), { bigint: true })

      // Equal size and restored mtime still change ctime; reads only change atime.
      writeFileSync(filename, 'two')
      current = { ...current, ctimeNs: current.ctimeNs + 1n }
      const denied = Object.assign(new Error('stat denied'), { code: 'EACCES' })
      stat.mockRejectedValueOnce(denied)
      await vi.advanceTimersByTimeAsync(100)
      expect(warn).toHaveBeenCalledWith(denied)
      expect(observed).toEqual(['one'])
      await vi.advanceTimersByTimeAsync(100)
      expect(observed).toEqual(['one', 'two'])

      writeFileSync(filename, 'new')
      current = { ...current, ino: current.ino + 1n }
      await vi.advanceTimersByTimeAsync(100)
      expect(observed).toEqual(['one', 'two', 'new'])
    } finally {
      await ctx.fiber.dispose()
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['registration', 'owner'] as const)('joins a pending stat on %s disposal without later work', async (owner) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-stop-'))
    const filename = join(dir, 'plugins.yml')
    writeFileSync(filename, 'one')
    const current = await fsPromises.stat(filename, { bigint: true })
    unlinkSync(filename)
    const ctx = await bootHmr(dir, [], { interval: 25 })
    const result = Promise.withResolvers<typeof current>()
    const refresh = vi.fn()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const dispose = await ctx.hmr.registerConfig(filename, refresh)
      const stat = vi.spyOn(fsPromises, 'stat').mockReturnValue(result.promise)
      syncBuiltinESMExports()
      await vi.advanceTimersByTimeAsync(24)
      expect(stat).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(stat).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(stat).toHaveBeenCalledTimes(1)

      let disposed = false
      const disposal = (owner === 'registration' ? dispose() : ctx.fiber.dispose()).then(() => { disposed = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(disposed).toBe(false)
      result.resolve(current)
      await disposal
      await vi.advanceTimersByTimeAsync(1000)
      expect(refresh).not.toHaveBeenCalled()
      expect(stat).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      result.resolve(current)
      await ctx.fiber.dispose()
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('owns cleanup before an initial refresh disposes its context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-initial-stop-'))
    const filename = join(dir, 'plugins.yml')
    writeFileSync(filename, 'one')
    const ctx = await bootHmr(dir)
    const release = Promise.withResolvers<undefined>()
    let disposal: Promise<void> | undefined
    let disposed = false
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await ctx.hmr.registerConfig(filename, async () => {
        disposal = ctx.fiber.dispose().then(() => { disposed = true })
        await release.promise
      })
      expect(disposal).toBeDefined()
      await vi.advanceTimersByTimeAsync(0)
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await disposal
      expect(disposed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects failed baselines and disposal during registration without admitting work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-baseline-'))
    const filename = join(dir, 'plugins.yml')
    writeFileSync(filename, 'one')
    const current = await fsPromises.stat(filename, { bigint: true })
    const canonical = join(await realpath(dir), 'plugins.yml')
    const ctx = await bootHmr(dir)
    const entered = Promise.withResolvers<undefined>()
    const result = Promise.withResolvers<typeof current>()
    const refresh = vi.fn()
    const denied = Object.assign(new Error('stat denied'), { code: 'EACCES' })
    const originalStat = fsPromises.stat
    let fail = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(fsPromises, 'stat').mockImplementation(async (...args: Parameters<typeof fsPromises.stat>) => {
      if (args[0] !== canonical) return originalStat(...args)
      if (fail) throw denied
      entered.resolve(undefined)
      return result.promise
    })
    syncBuiltinESMExports()
    try {
      await expect(ctx.hmr.registerConfig(filename, refresh)).rejects.toBe(denied)
      fail = false
      const registration = ctx.hmr.registerConfig(filename, refresh)
      await entered.promise
      await ctx.fiber.dispose()
      result.resolve(current)
      await expect(registration).rejects.toMatchObject({ code: 'INACTIVE_EFFECT' })
      expect(refresh).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      result.resolve(current)
      await ctx.fiber.dispose()
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
