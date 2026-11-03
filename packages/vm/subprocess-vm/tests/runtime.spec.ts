/**
 * VmSubprocessRuntime tests over one scripted world: resolution, spawn
 * stdio shapes (pipe, inherit is exercised through the pipe path, collect
 * tails with lossy offsets and UTF-8 holdback), stdin queues, termination
 * escalation, start-failure propagation, terminals, and disposal.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { VmWorld } from '@deepseek-ai/dsh-vm'
import type { CollectExecOptions, ExecExit, ExecHandle, ExecOptions, ExecOutputListener, ExecResult, VmWorldDescriptor, VmWorldExit, VmWorldFs } from '@deepseek-ai/dsh-vm'
import VmSubprocessRuntime from '../src/index.ts'

interface ScriptedExec {
  argv: readonly string[]
  options: CollectExecOptions | undefined
  result: ExecResult
}

class FakeExecHandle implements ExecHandle {
  readonly id: number
  readonly pid: number
  readonly signals: string[] = []
  readonly stdinChunks: (Uint8Array | string)[] = []
  stdinClosed = false
  stuck = false
  private readonly listeners = new Set<ExecOutputListener>()
  private readonly exitDeferred = Promise.withResolvers<ExecExit>()
  readonly exit = this.exitDeferred.promise

  constructor(pid: number) {
    this.id = pid
    this.pid = pid
  }

  writeStdin = (chunk: Uint8Array | string): void => { this.stdinChunks.push(chunk) }
  closeStdin = (): void => { this.stdinClosed = true }
  signalFails = false
  signal = async (sig: NodeJS.Signals): Promise<void> => {
    this.signals.push(sig)
    if (this.signalFails) throw new Error(`signal ${sig} refused`)
    if (sig === 'SIGKILL') this.settleExit({ code: 137, signal: 'SIGKILL' })
    else if (!this.stuck) this.settleExit({ code: null, signal: sig })
  }
  onOutput = (listener: ExecOutputListener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    for (const listener of [...this.listeners]) listener(stream, chunk)
  }

  settleExit(exit: ExecExit): void {
    this.exitDeferred.resolve(exit)
  }

  failExit(error: unknown): void {
    this.exitDeferred.reject(error)
  }
}

class ScriptedWorld extends VmWorld {
  readonly execCalls: ScriptedExec[] = []
  execQueue: ExecResult[] = []
  readonly spawnCalls: { argv: string[]; options: ExecOptions | undefined }[] = []
  spawnQueue: Array<Promise<FakeExecHandle> | Error> = []
  destroyed = 0

  override get descriptor(): VmWorldDescriptor {
    return { provider: 'fake', isolation: 'full', hostHardened: true, readyMs: 0 }
  }

  override get exit(): Promise<VmWorldExit> {
    return new Promise<VmWorldExit>(() => {})
  }

  override async ping(): Promise<number> {
    return 0
  }

  override async exec(argv: string[], options?: CollectExecOptions): Promise<ExecResult> {
    this.execCalls.push({ argv, options, result: undefined as never })
    const next = this.execQueue.shift()
    if (next === undefined) throw new Error('scripted world: exec queue empty')
    return next
  }

  override async spawn(argv: string[], options?: ExecOptions): Promise<FakeExecHandle> {
    this.spawnCalls.push({ argv, options })
    const next = this.spawnQueue.shift()
    if (next === undefined) throw new Error('scripted world: spawn queue empty')
    if (next instanceof Error) throw next
    if (typeof next === 'string') throw next
    return next
  }

  override get fs(): VmWorldFs {
    throw new Error('not implemented in the fixture')
  }

  override async destroy(): Promise<'clean'> {
    this.destroyed += 1
    return 'clean'
  }
}

async function setup(): Promise<{ ctx: Context; world: ScriptedWorld }> {
  const ctx = new Context()
  const world = new ScriptedWorld(ctx)
  await ctx.plugin(VmSubprocessRuntime)
  return { ctx, world }
}

const ok = (stdout = ''): ExecResult => ({ code: 0, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(''), timedOut: false })

describe('VmSubprocessRuntime', () => {
  it('registers over ctx.vm and reports a remote locality', async () => {
    const { ctx } = await setup()
    expect(ctx.subprocess.locality).toBe('remote')
    await ctx.fiber.dispose()
  })

  it('resolves bare names over the world PATH and verifies absolute paths', async () => {
    const { ctx, world } = await setup()
    world.execQueue.push(ok('/usr/bin/python3\n'), ok('ok'), { code: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false })
    await expect(ctx.subprocess.resolveExecutable('python3')).resolves.toBe('/usr/bin/python3')
    await expect(ctx.subprocess.resolveExecutable('/usr/bin/python3')).resolves.toBe('/usr/bin/python3')
    await expect(ctx.subprocess.resolveExecutable('missing')).rejects.toThrow("no such executable in the world's PATH: missing")
    expect(world.execCalls[0]!.argv).toEqual(['sh', '-c', "command -v 'python3'"])
    expect(world.execCalls[1]!.argv).toEqual(['sh', '-c', "test -x '/usr/bin/python3' && echo ok"])
    await ctx.fiber.dispose()
  })

  it('rejects relative executable paths with separators', async () => {
    const { ctx } = await setup()
    await expect(ctx.subprocess.resolveExecutable('./tool')).rejects.toThrow('refusing a relative executable path with separators: ./tool')
    await ctx.fiber.dispose()
  })

  it('spawns with collected tails, lossy offsets, and UTF-8 holdback', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(311)
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['busywork'],
      cwd: '/ws',
      graceMs: 5_000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8 },
        stderr: { maxBytes: 1_000 },
      },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(spawned.pid).toBe(311)
    handle.emit('stdout', Buffer.from('0123456789'))
    const afterTrim = spawned.collected.stdout!.readFrom(0)
    expect(afterTrim).toMatchObject({ text: '23456789', nextOffset: 10, lossy: true })
    handle.emit('stdout', Buffer.concat([Buffer.from('ab'), Buffer.from([0xE4]), Buffer.from([0xBD])]))
    const held = spawned.collected.stdout!.readFrom(0)
    expect(held).toMatchObject({ text: 'ab', lossy: true })
    handle.emit('stdout', Buffer.from([0xA0]))
    const completed = spawned.collected.stdout!.readFrom(held.nextOffset)
    expect(completed).toMatchObject({ text: '你', lossy: false })
    handle.emit('stderr', Buffer.from('warn'))
    expect(spawned.collected.stderr!.readFrom(0)).toMatchObject({ text: 'warn', lossy: false })
    handle.settleExit({ code: 0, signal: null })
    await expect(spawned.done).resolves.toEqual({ exitCode: 0, signal: null })
    await ctx.fiber.dispose()
  })

  it('streams piped output and queues stdin through the settle', async () => {
    const { ctx, world } = await setup()
    let releaseSpawn: ((handle: FakeExecHandle) => void) | undefined
    world.spawnQueue.push(new Promise<FakeExecHandle>((resolve) => { releaseSpawn = resolve }))
    const spawned = ctx.subprocess.spawn({
      argv: ['cat'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    expect(spawned.pid).toBe(-1)
    expect(spawned.stdout).toBeInstanceOf(Object)
    const chunks: string[] = []
    void spawned.stdout!.on('data', (chunk: Buffer) => { chunks.push(chunk.toString('utf8')) })
    spawned.stdin!.write('early')
    const handle = new FakeExecHandle(77)
    releaseSpawn!(handle)
    await new Promise((resolve) => { setImmediate(resolve) })
    spawned.stdin!.write('late')
    spawned.stdin!.end()
    handle.emit('stdout', Buffer.from('out'))
    handle.settleExit({ code: 3, signal: null })
    await expect(spawned.done).resolves.toEqual({ exitCode: 3, signal: null })
    const decode = (chunks: readonly (Uint8Array | string)[]): string[] => chunks.map(chunk => Buffer.from(chunk).toString('utf8'))
    expect(decode(handle.stdinChunks)).toEqual(['early', 'late'])
    expect(handle.stdinClosed).toBe(true)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(chunks).toEqual(['out'])
    await ctx.fiber.dispose()
  })

  it('writes batch stdin data once and closes it', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(9)
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['wc'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: { data: 'payload' }, stdout: 'pipe', stderr: 'pipe' },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    const decode = (chunks: readonly (Uint8Array | string)[]): string[] => chunks.map(chunk => Buffer.from(chunk).toString('utf8'))
    expect(decode(handle.stdinChunks)).toEqual(['payload'])
    expect(handle.stdinClosed).toBe(true)
    handle.settleExit({ code: 0, signal: null })
    await spawned.done
    await ctx.fiber.dispose()
  })

  it('escalates termination SIGTERM to SIGKILL after the grace period', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(5)
    handle.stuck = true
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['stuck'],
      cwd: '/',
      graceMs: 30,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: { maxBytes: 10 } },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    spawned.terminate()
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    expect(handle.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await spawned.done
    await expect(spawned.waitForExit()).resolves.toBe(true)
    await ctx.fiber.dispose()
  })

  it('honors a caller abort signal and waitForExit bounds', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(6)
    world.spawnQueue.push(Promise.resolve(handle))
    const controller = new AbortController()
    const spawned = ctx.subprocess.spawn({
      argv: ['sleeper'],
      cwd: '/',
      graceMs: 5_000,
      signal: controller.signal,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: { maxBytes: 10 } },
    })
    handle.stuck = true
    await new Promise((resolve) => { setImmediate(resolve) })
    controller.abort()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(handle.signals).toEqual(['SIGTERM'])
    const bound = new AbortController()
    const waiting = spawned.waitForExit(bound.signal)
    bound.abort()
    await expect(waiting).resolves.toBe(false)
    handle.settleExit({ code: null, signal: 'SIGTERM' })
    await spawned.done
    await expect(spawned.waitForExit()).resolves.toBe(true)
    await ctx.fiber.dispose()
  })

  it('propagates a start failure through done and destroys pipes', async () => {
    const { ctx, world } = await setup()
    world.spawnQueue.push(new Error('the world refused the exec'))
    const spawned = ctx.subprocess.spawn({
      argv: ['denied'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    const errored = Promise.all([
      new Promise<unknown>((resolve) => { spawned.stdout!.once('error', resolve) }),
      new Promise<unknown>((resolve) => { spawned.stderr!.once('error', resolve) }),
    ])
    await expect(spawned.done).rejects.toThrow('the world refused the exec')
    await errored
    await ctx.fiber.dispose()
  })

  it('runs terminals inside the world with pty facts and refuses unsupported operations', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(44)
    handle.stuck = true
    world.spawnQueue.push(Promise.resolve(handle))
    const terminal = await ctx.subprocess.spawnTerminal({
      argv: ['sh'],
      cwd: '/ws',
      rows: 30,
      cols: 100,
      term: 'xterm-256color',
      graceMs: 30,
    })
    expect(terminal.pid).toBe(44)
    expect(world.spawnCalls[0]!.options).toEqual({ cwd: '/ws', env: { TERM: 'xterm-256color' }, pty: { rows: 30, cols: 100 } })
    const seen: string[] = []
    void terminal.output.on('data', (chunk: Buffer) => { seen.push(chunk.toString('utf8')) })
    handle.emit('stdout', Buffer.from('hello'))
    await terminal.write('hi')
    const decode = (chunks: readonly (Uint8Array | string)[]): string[] => chunks.map(chunk => Buffer.from(chunk).toString('utf8'))
    expect(decode(handle.stdinChunks)).toEqual(['hi'])
    await expect(terminal.resize(80, 24)).rejects.toThrow('no pty resize operation')
    await expect(terminal.inspectForeground()).resolves.toBeUndefined()
    await expect(terminal.signalForeground('SIGINT')).rejects.toThrow('no terminal foreground group')
    await terminal.terminate()
    expect(handle.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await terminal.done
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(seen).toEqual(['hello'])
    await ctx.fiber.dispose()
  })

  it('passes only defined env entries and omits env entirely when absent', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(21)
    world.spawnQueue.push(Promise.resolve(handle))
    ctx.subprocess.spawn({
      argv: ['env-test'],
      cwd: '/',
      graceMs: 5_000,
      env: { FOO: 'x', DEAD: undefined },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: { maxBytes: 10 } },
    })
    handle.settleExit({ code: 0, signal: null })
    const handleTwo = new FakeExecHandle(22)
    world.spawnQueue.push(Promise.resolve(handleTwo))
    ctx.subprocess.spawn({
      argv: ['no-env'],
      cwd: '/ws',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: { maxBytes: 10 } },
    })
    handleTwo.settleExit({ code: 0, signal: null })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(world.spawnCalls.map(call => call.options)).toEqual([
      { cwd: '/', env: { FOO: 'x' } },
      { cwd: '/ws' },
    ])
    await ctx.fiber.dispose()
  })

  it('trims one oversized chunk to the retained tail', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(23)
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['burst'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    handle.emit('stdout', Buffer.from('abcdefghijklmnopqrst'))
    expect(spawned.collected.stdout!.readFrom(0)).toMatchObject({ text: 'mnopqrst', nextOffset: 20, lossy: true })
    handle.settleExit({ code: 0, signal: null })
    await spawned.done
    await ctx.fiber.dispose()
  })

  it('covers the remaining resolution and abort branches', async () => {
    const { ctx, world } = await setup()
    world.execQueue.push({ code: 0, signal: null, stdout: Buffer.from(''), stderr: Buffer.alloc(0), timedOut: false })
    await expect(ctx.subprocess.resolveExecutable('ghost')).rejects.toThrow("the world's PATH resolved ghost to nothing")
    world.execQueue.push({ code: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false })
    await expect(ctx.subprocess.resolveExecutable('/bin/nope')).rejects.toThrow('not an executable inside the world: /bin/nope')
    world.execQueue.push({ code: 0, signal: null, stdout: Buffer.from('/usr/bin/tool\n'), stderr: Buffer.alloc(0), timedOut: false })
    await expect(ctx.subprocess.resolveExecutable('tool', { PATH: '/usr/bin' })).resolves.toBe('/usr/bin/tool')
    expect(world.execCalls.at(-1)!.options).toEqual({ env: { PATH: '/usr/bin' } })
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.subprocess.resolveExecutable('tool', undefined, controller.signal)).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('starts the escalation immediately for a pre-aborted signal', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(27)
    world.spawnQueue.push(Promise.resolve(handle))
    const controller = new AbortController()
    controller.abort()
    const spawned = ctx.subprocess.spawn({
      argv: ['late'],
      cwd: '/',
      graceMs: 5_000,
      signal: controller.signal,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: { maxBytes: 10 } },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(handle.signals).toEqual(['SIGTERM'])
    handle.settleExit({ code: null, signal: 'SIGTERM' })
    await spawned.done
    await ctx.fiber.dispose()
  })

  it('queues stdin writes through a failed start without surfacing them', async () => {
    const { ctx, world } = await setup()
    world.spawnQueue.push(new Error('refused'))
    const spawned = ctx.subprocess.spawn({
      argv: ['denied'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    const streamFailed = Promise.all([
      new Promise<unknown>((resolve) => { spawned.stdin!.once('error', resolve) }),
      new Promise<unknown>((resolve) => { spawned.stdout!.once('error', resolve) }),
      new Promise<unknown>((resolve) => { spawned.stderr!.once('error', resolve) }),
    ])
    spawned.stdin!.write('never-arrives')
    await expect(spawned.done).rejects.toThrow('refused')
    spawned.stdin!.end()
    await streamFailed
    await ctx.fiber.dispose()
  })

  it('treats terminate after exit as a no-op', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(24)
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['quick'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: { maxBytes: 10 } },
    })
    handle.settleExit({ code: 0, signal: null })
    await spawned.done
    spawned.terminate()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(handle.signals).toEqual([])
    await ctx.fiber.dispose()
  })

  it('loses waitForExit to a mid-flight bound abort', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(25)
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['sleeper'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: { maxBytes: 10 } },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    const bound = new AbortController()
    const waiting = spawned.waitForExit(bound.signal)
    setTimeout(() => { bound.abort() }, 10)
    await expect(waiting).resolves.toBe(false)
    handle.settleExit({ code: 0, signal: null })
    await spawned.done
    await ctx.fiber.dispose()
  })

  it('refuses a terminal allocation whose signal already aborted', async () => {
    const { ctx } = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.subprocess.spawnTerminal({
      argv: ['sh'],
      cwd: '/',
      rows: 24,
      cols: 80,
      graceMs: 5_000,
      signal: controller.signal,
    })).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('destroys the terminal output stream when the world exec fails', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(26)
    handle.stuck = true
    world.spawnQueue.push(Promise.resolve(handle))
    const terminal = await ctx.subprocess.spawnTerminal({ argv: ['sh'], cwd: '/', rows: 24, cols: 80, graceMs: 5_000 })
    const ended = new Promise<void>((resolve) => { terminal.output.once('close', resolve) })
    handle.failExit(new Error('world closed'))
    await terminal.done.then(() => {}, () => {})
    await ended
    await terminal.terminate().catch(() => {})
    await ctx.fiber.dispose()
  })

  it('covers the remaining stdio and stream paths', async () => {
    const { ctx, world } = await setup()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const inherit = new FakeExecHandle(31)
    world.spawnQueue.push(Promise.resolve(inherit))
    const inherited = ctx.subprocess.spawn({
      argv: ['inherit-out'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    inherit.emit('stdout', Buffer.from('to-stdout'))
    inherit.emit('stderr', Buffer.from('to-stderr'))
    inherit.settleExit({ code: 0, signal: null })
    await inherited.done
    write.mockRestore()

    const failing = new FakeExecHandle(32)
    world.spawnQueue.push(Promise.resolve(failing))
    const crashed = ctx.subprocess.spawn({
      argv: ['crash'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    const streamsFailed = Promise.all([
      new Promise<unknown>((resolve) => { crashed.stdout!.once('error', resolve) }),
      new Promise<unknown>((resolve) => { crashed.stderr!.once('error', resolve) }),
    ])
    await new Promise((resolve) => { setImmediate(resolve) })
    failing.failExit(new Error('world transport died'))
    await streamsFailed

    const wide = new FakeExecHandle(33)
    world.spawnQueue.push(Promise.resolve(wide))
    const wideSpawn = ctx.subprocess.spawn({
      argv: ['wide'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    wide.emit('stdout', Buffer.concat([Buffer.from('cd'), Buffer.from([0xF0, 0x9F]), Buffer.from([0x98, 0x80])]))
    const partial = wideSpawn.collected.stdout!.readFrom(0)
    expect(partial.text).toBe('cd\u{1F600}')
    wide.emit('stdout', Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80]))
    const drained = wideSpawn.collected.stdout!.readFrom(partial.nextOffset)
    expect(drained.lossy).toBe(false)
    wide.settleExit({ code: 0, signal: null })
    await wideSpawn.done

    const early = new AbortController()
    early.abort()
    const handle34 = new FakeExecHandle(34)
    world.spawnQueue.push(Promise.resolve(handle34))
    const bounded = ctx.subprocess.spawn({
      argv: ['bounded'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } },
    })
    handle34.settleExit({ code: 0, signal: null })
    await bounded.done
    await expect(bounded.waitForExit(early.signal)).resolves.toBe(false)
    await ctx.fiber.dispose()
  })

  it('surfaces start failures on writes that arrive after the failure', async () => {
    const { ctx, world } = await setup()
    world.spawnQueue.push(new Error('late refusal'))
    const spawned = ctx.subprocess.spawn({
      argv: ['denied-late'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    const failed = Promise.all([
      new Promise<unknown>((resolve) => { spawned.stdin!.once('error', resolve) }),
      new Promise<unknown>((resolve) => { spawned.stdout!.once('error', resolve) }),
      new Promise<unknown>((resolve) => { spawned.stderr!.once('error', resolve) }),
    ])
    await expect(spawned.done).rejects.toThrow('late refusal')
    spawned.stdin!.write('after-failure')
    await failed
    await ctx.fiber.dispose()
  })

  it('covers 3-byte holdback, string rejections, and terminal signals', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(36)
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['holdback'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: 'pipe' },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    handle.emit('stdout', Buffer.concat([Buffer.from('cd'), Buffer.from([0xE4, 0xBD])]))
    const held = spawned.collected.stdout!.readFrom(0)
    expect(held.text).toBe('cd')
    handle.emit('stdout', Buffer.from([0xA0]))
    expect(spawned.collected.stdout!.readFrom(held.nextOffset).text).toBe('你')
    handle.settleExit({ code: 0, signal: null })
    await spawned.done

    world.spawnQueue.push('raw refusal' as never)
    const rejected = ctx.subprocess.spawn({
      argv: ['string-failure'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    const rawFailed = Promise.all([
      new Promise<unknown>((resolve) => { rejected.stdout!.once('error', resolve) }),
      new Promise<unknown>((resolve) => { rejected.stderr!.once('error', resolve) }),
    ])
    await expect(rejected.done).rejects.toThrow('raw refusal')
    await rawFailed

    const terminalHandle = new FakeExecHandle(37)
    world.spawnQueue.push(Promise.resolve(terminalHandle))
    const attached = new AbortController()
    const terminal = await ctx.subprocess.spawnTerminal({ argv: ['sh'], cwd: '/', rows: 24, cols: 80, graceMs: 5_000, signal: attached.signal })
    expect(terminal.pid).toBe(37)
    terminalHandle.stuck = true
    attached.abort()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(terminalHandle.signals).toEqual(['SIGTERM'])
    terminalHandle.settleExit({ code: null, signal: 'SIGTERM' })
    await terminal.done
    await ctx.fiber.dispose()
  })

  it('swallows refused signals through the escalation and covers 2-byte holdback', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(38)
    handle.stuck = true
    handle.signalFails = true
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['unsignalable'],
      cwd: '/',
      graceMs: 20,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
    })
    const bounded = new AbortController()
    const exitWait = spawned.waitForExit(bounded.signal)
    await new Promise((resolve) => { setImmediate(resolve) })
    spawned.terminate()
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    expect(handle.signals).toEqual(['SIGTERM', 'SIGKILL'])
    bounded.abort()
    await expect(exitWait).resolves.toBe(false)
    handle.settleExit({ code: 0, signal: null })
    await spawned.done
    await expect(spawned.waitForExit()).resolves.toBe(true)

    const two = new FakeExecHandle(39)
    world.spawnQueue.push(Promise.resolve(two))
    const twoSpawn = ctx.subprocess.spawn({
      argv: ['two-byte'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 64 } },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    two.emit('stdout', Buffer.concat([Buffer.from('e'), Buffer.from([0xC2])]))
    const held = twoSpawn.collected.stdout!.readFrom(0)
    expect(held.text).toBe('e')
    two.emit('stdout', Buffer.from([0xA2]))
    expect(twoSpawn.collected.stdout!.readFrom(held.nextOffset).text).toBe('\u00A2')
    two.settleExit({ code: 0, signal: null })
    await twoSpawn.done
    await ctx.fiber.dispose()
  })

  it('destroys pipes with the raw rejection reason', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(40)
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['raw-exit'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    const rawExit = Promise.all([
      new Promise<unknown>((resolve) => { spawned.stdout!.once('error', resolve) }),
      new Promise<unknown>((resolve) => { spawned.stderr!.once('error', resolve) }),
    ])
    await new Promise((resolve) => { setImmediate(resolve) })
    handle.failExit('raw exit failure')
    await rawExit
    await expect(spawned.done).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('covers the terminal signal-refusal escalation and spawn-failure teardown arms', async () => {
    const { ctx, world } = await setup()
    const terminalHandle = new FakeExecHandle(41)
    terminalHandle.stuck = true
    terminalHandle.signalFails = true
    world.spawnQueue.push(Promise.resolve(terminalHandle))
    const terminal = await ctx.subprocess.spawnTerminal({ argv: ['sh'], cwd: '/', rows: 24, cols: 80, graceMs: 20 })
    const terminalDone = terminal.done
    void terminal.terminate()
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    expect(terminalHandle.signals).toEqual(['SIGTERM', 'SIGKILL'])
    terminalHandle.settleExit({ code: 137, signal: 'SIGKILL' })
    await terminalDone

    world.spawnQueue.push(new Promise<FakeExecHandle>((_, reject) => {
      setTimeout(() => { reject(new Error('slow refusal')) }, 10)
    }))
    const failed = ctx.subprocess.spawn({
      argv: ['teardown'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } },
    })
    failed.terminate()
    await expect(failed.done).rejects.toThrow('slow refusal')
    await expect(failed.waitForExit()).resolves.toBe(true)
    await ctx.fiber.dispose()
  })

  it('runs the escalation and bounded-wait arms under exit rejection', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(42)
    handle.stuck = true
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['dies-mid-escalation'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    spawned.terminate()
    handle.failExit(new Error('died during escalation'))
    await expect(spawned.done).rejects.toThrow('died during escalation')
    const bound = new AbortController()
    await expect(spawned.waitForExit(bound.signal)).resolves.toBe(true)
    await ctx.fiber.dispose()
  })

  it('terminates a live terminal on service disposal', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(35)
    handle.stuck = true
    world.spawnQueue.push(Promise.resolve(handle))
    await ctx.subprocess.spawnTerminal({ argv: ['sh'], cwd: '/', rows: 24, cols: 80, graceMs: 30 })
    await ctx.fiber.dispose()
    expect(handle.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('terminates every live child on service disposal', async () => {
    const { ctx, world } = await setup()
    const handle = new FakeExecHandle(8)
    world.spawnQueue.push(Promise.resolve(handle))
    const spawned = ctx.subprocess.spawn({
      argv: ['long'],
      cwd: '/',
      graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: { maxBytes: 10 } },
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    await ctx.fiber.dispose()
    expect(handle.signals).toEqual(['SIGTERM'])
    handle.settleExit({ code: null, signal: 'SIGTERM' })
    await spawned.done
  })
})
