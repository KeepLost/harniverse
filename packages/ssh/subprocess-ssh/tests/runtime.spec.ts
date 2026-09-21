/** Remote subprocess provider over scripted SSH: spawn wiring, pull streams, stdin chunking, terminal control, and disposal joins. */
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessOutputRead, SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import SshSubprocessRuntime from '../src/index.ts'

interface Call {
  method: string
  params: Record<string, unknown>
  signal?: AbortSignal
  wait?: boolean
}

interface ScriptedProcess {
  pid: number
  outcome: { exitCode: number | null; signal: string | null } | null
  collected: { stdout?: SubprocessOutputRead; stderr?: SubprocessOutputRead }
  reads: Record<string, (string | null)[]>
  terminal: boolean
}

interface Mount {
  runtime: SshSubprocessRuntime
  ctx: Context
  controller: AbortController
  calls: Call[]
  processes: Map<string, ScriptedProcess>
  gates: Map<string, PromiseWithResolvers<void>>
  spawnFailure: Error | null
  holdSpawn: boolean
  writeFailure: unknown
  signalFailure: boolean
  terminateFailure: boolean
}

const contexts: Context[] = []
const outcome = { exitCode: 0, signal: null }

const mount = async (): Promise<Mount> => {
  const ctx = new Context()
  contexts.push(ctx)
  const controller = new AbortController()
  const calls: Call[] = []
  const processes = new Map<string, ScriptedProcess>()
  const gates = new Map<string, PromiseWithResolvers<void>>()
  const state: Mount = {
    runtime: null as never,
    ctx,
    controller,
    calls,
    processes,
    gates,
    spawnFailure: null,
    holdSpawn: false,
    writeFailure: null,
    signalFailure: false,
    terminateFailure: false,
  }
  let nextPid = 1000
  ctx.provide('ssh', {
    request: async <T>(
      method: string,
      params: Record<string, unknown>,
      schema: { parse: (value: unknown) => T },
      signal?: AbortSignal,
      wait?: boolean,
    ): Promise<T> => {
      const call: Call = wait === undefined
        ? (signal === undefined ? { method, params } : { method, params, signal })
        : (signal === undefined ? { method, params, wait } : { method, params, signal, wait })
      calls.push(call)
      const gate = gates.get(`${method}:${(params as { id?: string }).id ?? ''}`)
      if (gate !== undefined) await gate.promise
      const value = await reply(state, method, params)
      if (value instanceof Error) throw value
      return schema.parse(value)
    },
    signal: controller.signal,
  } as never)
  await ctx.plugin(SshSubprocessRuntime)
  state.runtime = (ctx as unknown as { subprocess: SshSubprocessRuntime }).subprocess
  return state

  async function reply(machine: Mount, method: string, params: unknown): Promise<unknown> {
    if (method === 'executable') return '/machine/bin/tool'
    if (method === 'process.spawn') {
      if (machine.holdSpawn) {
        let gate = machine.gates.get('process.spawn:')
        if (gate === undefined) {
          gate = Promise.withResolvers()
          machine.gates.set('process.spawn:', gate)
        }
        await gate.promise
      }
      if (machine.spawnFailure !== null) return machine.spawnFailure
      const id = randomUUID()
      const terminal = 'terminal' in (params as object)
      machine.processes.set(id, { pid: nextPid++, outcome: null, collected: {}, reads: {}, terminal })
      return { id, pid: machine.processes.get(id)!.pid }
    }
    const process = machine.processes.get(String((params as { id?: string }).id))
    if (process === undefined) return new Error('Unknown SSH process handle')
    if (method === 'process.state') return { outcome: process.outcome, collected: process.collected }
    if (method === 'process.read') {
      const queue = process.reads[String((params as { stream?: string }).stream)] ?? []
      return queue.length > 0 ? queue.shift()! : null
    }
    if (method === 'process.terminate') {
      process.outcome ??= { exitCode: null, signal: 'SIGTERM' }
      if (machine.terminateFailure) return new Error('terminate refused')
      return null
    }
    if (method === 'process.wait') return true
    if (method === 'terminal.write') {
      if ((params as { data?: unknown }).data === null) return new Error('Missing stdin data')
      return null
    }
    if (method === 'terminal.resize') return null
    if (method === 'terminal.inspect') return process.outcome === null ? { processGroupId: 9, inputWaiting: false } : null
    if (method === 'terminal.signal') {
      if (machine.signalFailure) return new Error('bad terminal signal')
      return 2
    }
    if (method === 'process.write' && machine.writeFailure !== null) {
      const failure = machine.writeFailure
      throw failure
    }
    return null
  }
}

const spec = (overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec => ({
  argv: ['/machine/bin/tool', 'run'],
  cwd: '/machine/work',
  graceMs: 1000,
  stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  ...overrides,
})

describe('SSH subprocess provider', () => {
  afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

  it('resolves executables on the machine', async () => {
    const state = await mount()
    expect(await state.runtime.resolveExecutable('tool', { PATH: '/machine/bin' }, undefined)).toBe('/machine/bin/tool')
    expect(state.calls[0]).toMatchObject({ method: 'executable', params: { command: 'tool', env: { PATH: '/machine/bin' } } })
  })

  it('spawns, streams output, polls to completion, and joins quiescence', async () => {
    const state = await mount()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    state.gates.set('process.spawn:', gate)
    const handle = state.runtime.spawn(spec())
    gate.resolve()
    await new Promise((resolve) => { setImmediate(resolve) })
    const spawned = [...state.processes.entries()].at(-1)!
    spawned[1].reads.stdout = [Buffer.from('hello ').toString('base64'), Buffer.from('world').toString('base64'), null]
    spawned[1].outcome = outcome
    expect(handle.pid).toBe(spawned[1].pid)
    const collected: string[] = []
    for await (const chunk of handle.stdout!) collected.push(`${chunk}`)
    expect(collected.join('')).toBe('hello world')
    const drained: string[] = []
    for await (const chunk of handle.stderr!) drained.push(`${chunk}`)
    expect(drained).toEqual([])
    expect(await handle.done).toEqual(outcome)
    expect(await handle.waitForExit()).toBe(true)
    const write = state.calls.find(call => call.method === 'process.wait')
    expect(write?.wait).toBe(true)
    const deadline = Date.now() + 2000
    while (!state.calls.some(call => call.method === 'process.release') && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 5) })
    const methods = state.calls.map(call => `${call.method}:${(call.params as { stream?: string }).stream ?? ''}`)
    expect(methods).toContain('process.read:stdout')
    expect(methods).toContain('process.terminate:')
    expect(methods).toContain('process.release:')
    expect(handle.stderr).toBeDefined()
    expect(handle.stdin).toBeDefined()
  })

  it('chunks stdin writes and ends with a null frame', async () => {
    const state = await mount()
    const spawned = (() => {
      const handle = state.runtime.spawn(spec())
      return { handle, record: [...state.processes.values()].at(-1)! }
    })()
    spawned.record.outcome = outcome
    await new Promise<void>((resolve, reject) => {
      const chunk = Buffer.alloc(50 * 1024, 0x61)
      spawned.handle.stdin!.write(chunk, (error) => { if (error) reject(error); else resolve() })
    })
    spawned.handle.stdin!.end(() => {})
    await spawned.handle.done
    const frames = state.calls.filter(call => call.method === 'process.write').map(call => (call.params as { data: string | null }).data)
    expect(frames).toHaveLength(4)
    expect(Buffer.from(frames[0] as string, 'base64')).toHaveLength(24 * 1024)
    expect(Buffer.from(frames[1] as string, 'base64')).toHaveLength(24 * 1024)
    expect(Buffer.from(frames[2] as string, 'base64')).toHaveLength(2 * 1024)
    expect(frames.at(-1)).toBeNull()
  })

  it('exposes collected snapshots with lossy replay detection', async () => {
    const state = await mount()
    const handle = state.runtime.spawn(spec({ stdio: { stdin: 'pipe', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } }))
    const record = [...state.processes.values()].at(-1)!
    record.collected.stdout = { text: 'efgh', nextOffset: 8, lossy: false }
    record.outcome = outcome
    await handle.done
    const collected = handle.collected as {
      stdout?: { readFrom: (offset: number) => SubprocessOutputRead }
      stderr?: { readFrom: (offset: number) => SubprocessOutputRead }
    }
    expect(collected.stdout!.readFrom(8)).toMatchObject({ text: '', lossy: false })
    expect(collected.stdout!.readFrom(4)).toMatchObject({ text: 'efgh', lossy: false })
    expect(collected.stdout!.readFrom(2)).toMatchObject({ text: 'efgh', lossy: true })
    expect(collected.stderr!.readFrom(4)).toMatchObject({ text: '', lossy: false })
    handle.terminate()
    expect(handle.stdout).toBeUndefined()
    expect(handle.stderr).toBeUndefined()
    const wire = state.calls.find(call => call.method === 'process.spawn')!.params as {
      stdio: { stdout: unknown; stderr: unknown }
      env: unknown
      limits: unknown
    }
    expect(wire.stdio.stdout).toEqual({ maxBytes: 4096 })
    expect(wire.env).toBeUndefined()
    expect(wire.limits).toBeUndefined()
  })

  it('maps wire specs for inherit, env nulling, and limits', async () => {
    const state = await mount()
    state.runtime.spawn(spec({
      stdio: { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' },
      env: { FOO: 'bar', BAZ: undefined },
      limits: { maxMemoryBytes: 4096 },
    }))
    const wire = state.calls.find(call => call.method === 'process.spawn')!.params as {
      stdio: Record<string, unknown>
      env: Record<string, string | null>
      limits: unknown
    }
    expect(wire.stdio.stdout).toBe('pipe')
    expect(wire.stdio.stderr).toBe('pipe')
    expect(wire.env).toEqual({ FOO: 'bar', BAZ: null })
    expect(wire.limits).toEqual({ maxMemoryBytes: 4096 })
    const inherit = state.runtime.spawn(spec({ stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }))
    ;[...state.processes.values()].at(-1)!.outcome = outcome
    expect(inherit.stdin).toBeDefined()
    await inherit.done
    const ignored = state.runtime.spawn(spec({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }))
    ;[...state.processes.values()].at(-1)!.outcome = outcome
    expect(ignored.stdin).toBeUndefined()
    await ignored.done
  })

  it('terminates on abort signals and reports failed allocations', async () => {
    const state = await mount()
    const specController = new AbortController()
    const handle = state.runtime.spawn(spec({ signal: specController.signal }))
    const record = [...state.processes.values()].at(-1)!
    record.reads.stdout = [Buffer.from('partial').toString('base64'), null]
    specController.abort(new Error('caller cancelled'))
    await handle.done
    expect(record.outcome).toMatchObject({ exitCode: null })
    expect(state.calls.some(call => call.method === 'process.terminate')).toBe(true)
    await new Promise((resolve) => { setImmediate(resolve) })

    const failing = await mount()
    failing.spawnFailure = new Error('spawn ENOENT')
    const broken = failing.runtime.spawn(spec())
    await expect(broken.done).rejects.toThrow('spawn ENOENT')
    await expect(broken.waitForExit()).rejects.toThrow('spawn ENOENT')
  })

  it('bounds waitForExit on a caller signal', async () => {
    const state = await mount()
    const handle = state.runtime.spawn(spec())
    const record = [...state.processes.values()].at(-1)!
    const waitGate: PromiseWithResolvers<void> = Promise.withResolvers()
    const id = [...state.processes.keys()].at(-1)!
    state.gates.set(`process.wait:${id}`, waitGate)
    record.outcome = outcome
    await handle.done
    const bound = new AbortController()
    const pending = handle.waitForExit(bound.signal)
    bound.abort(new Error('wait cancelled'))
    expect(await pending).toBe(false)
    waitGate.resolve()
    expect(await handle.waitForExit()).toBe(true)
    expect(await handle.waitForExit(AbortSignal.abort(new Error('already')))).toBe(false)
  })

  it('refuses spawns after disposal and joins allocation races', async () => {
    const state = await mount()
    state.holdSpawn = true
    const handle = state.runtime.spawn(spec())
    const terminal = state.runtime.spawnTerminal({ argv: ['/bin/sh'], cwd: '/machine/work', rows: 24, cols: 80 } as unknown as SubprocessTerminalSpawnSpec).catch((error: unknown) => error)
    const disposal = state.ctx.fiber.dispose()
    state.gates.get('process.spawn:')!.resolve()
    await disposal
    await handle.done.catch(() => {})
    const terminalOutcome = await terminal
    expect(String(terminalOutcome)).toContain('cancelled')
    expect(() => state.runtime.spawn(spec())).toThrow('SSH subprocess provider disposed')
    await expect(state.runtime.spawnTerminal({ argv: ['/bin/sh'], cwd: '/machine/work' } as unknown as SubprocessTerminalSpawnSpec)).rejects.toThrow('disposed')
  }, 10_000)

  it('drives terminals through writes, resize, foreground control, and cleanup', async () => {
    const state = await mount()
    const handle = await state.runtime.spawnTerminal({ argv: ['/bin/sh'], cwd: '/machine/work', rows: 24, cols: 80 } as unknown as SubprocessTerminalSpawnSpec)
    const record = [...state.processes.values()].at(-1)!
    expect(record.terminal).toBe(true)
    record.reads.terminal = [Buffer.from('prompt').toString('base64'), null]
    const collected: string[] = []
    for await (const chunk of handle.output) collected.push(`${chunk}`)
    expect(collected.join('')).toBe('prompt')
    await handle.write('ls\n')
    await handle.resize(100, 40)
    expect(await handle.inspectForeground()).toEqual({ processGroupId: 9, inputWaiting: false })
    record.outcome = outcome
    expect(await handle.inspectForeground()).toBeUndefined()
    expect(await handle.signalForeground('SIGINT')).toBe(2)
    await handle.done
    await handle.terminate()
    await expect(handle.write('gone')).rejects.toThrow('SSH terminal is closing')
    const methods = state.calls.map(call => call.method)
    expect(methods).toContain('terminal.write')
    expect(methods).toContain('terminal.resize')
    expect(methods).toContain('terminal.inspect')
    expect(methods).toContain('terminal.signal')
    expect(methods).toContain('process.release')
  })

  it('terminates immediately when the spawn signal arrives pre-aborted', async () => {
    const state = await mount()
    state.terminateFailure = true
    const handle = state.runtime.spawn(spec({ signal: AbortSignal.abort(new Error('too late')) }))
    await handle.done.catch(() => {})
    expect(state.calls.some(call => call.method === 'process.terminate')).toBe(true)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    handle.terminate()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(state.calls.filter(call => call.method === 'process.terminate')).toHaveLength(1)
  })

  it('surfaces stdin write and end failures', async () => {
    const refused = await mount()
    const first = refused.runtime.spawn(spec())
    ;[...refused.processes.values()].at(-1)!.outcome = outcome
    refused.writeFailure = 'plain refusal'
    const failure = await new Promise<unknown>((resolve, reject) => {
      first.stdin!.once('error', (error) => { reject(error) })
      first.stdin!.write(Buffer.from('x'), (error) => { if (error) reject(error); else resolve(undefined) })
    }).catch((error: unknown) => error)
    expect(String(failure)).toContain('plain refusal')

    const plain = await mount()
    const second = plain.runtime.spawn(spec())
    ;[...plain.processes.values()].at(-1)!.outcome = outcome
    const bare = await new Promise<unknown>((resolve) => {
      second.stdin!.once('error', (error: Error) => { resolve(error) })
      second.stdin!.write(Buffer.from('y'), (error: Error | null | undefined) => { resolve(error ?? 'no error') })
    })
    expect(bare).toBe('no error')
    plain.writeFailure = new Error('end refused')
    const finalFailure = await new Promise<unknown>((resolve) => {
      second.stdin!.once('error', (error: Error) => { resolve(error) })
      second.stdin!.end((error: Error | null | undefined) => { resolve(error ?? 'clean end') })
    })
    expect(String(finalFailure)).toContain('end refused')

    const errored = await mount()
    errored.writeFailure = new Error('write refused')
    const third = errored.runtime.spawn(spec())
    ;[...errored.processes.values()].at(-1)!.outcome = outcome
    const thirdFailure = await new Promise<unknown>((resolve, reject) => {
      third.stdin!.once('error', (error) => { reject(error) })
      third.stdin!.write(Buffer.from('z'), (error) => { if (error) reject(error); else resolve(undefined) })
    }).catch((error: unknown) => error)
    expect(String(thirdFailure)).toContain('write refused')

    const textual = await mount()
    const fourth = textual.runtime.spawn(spec())
    ;[...textual.processes.values()].at(-1)!.outcome = outcome
    await new Promise<unknown>((resolve) => {
      fourth.stdin!.write(Buffer.from('w'), (error: Error | null | undefined) => { resolve(error ?? undefined) })
    })
    textual.writeFailure = 'plain end refusal'
    const fourthFailure = await new Promise<unknown>((resolve) => {
      fourth.stdin!.once('error', (error: Error) => { resolve(error) })
      fourth.stdin!.end((error: Error | null | undefined) => { resolve(error ?? 'clean end') })
    })
    expect(String(fourthFailure)).toContain('plain end refusal')
  })

  it('fails terminal control operations and joins a pending terminal at termination', async () => {
    const state = await mount()
    state.signalFailure = true
    const refused = await state.runtime.spawnTerminal({ argv: ['/bin/sh'], cwd: '/machine/work' } as unknown as SubprocessTerminalSpawnSpec)
    await expect(refused.signalForeground('SIGINT')).rejects.toThrow('bad terminal signal')
    await refused.terminate().catch(() => {})

    const pending = await mount()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const handle = await pending.runtime.spawnTerminal({ argv: ['/bin/sh'], cwd: '/machine/work' } as unknown as SubprocessTerminalSpawnSpec)
    const id = [...pending.processes.keys()].at(-1)!
    pending.gates.set(`process.state:${id}`, gate)
    pending.controller.abort(new Error('connection lost'))
    gate.resolve()
    await expect(handle.done).rejects.toThrow()
    await expect(handle.terminate()).rejects.toThrow()
  })

  it('cancels terminal allocations racing an aborted signal', async () => {
    const state = await mount()
    state.holdSpawn = true
    const specController = new AbortController()
    const allocation = state.runtime.spawnTerminal({ argv: ['/bin/sh'], cwd: '/machine/work', signal: specController.signal } as unknown as SubprocessTerminalSpawnSpec)
    specController.abort(new Error('cancelled before ready'))
    state.gates.get('process.spawn:')!.resolve()
    await expect(allocation).rejects.toThrow('SSH terminal allocation cancelled')
    const methods = state.calls.map(call => call.method)
    expect(methods).toContain('process.terminate')
    expect(methods).toContain('process.release')
  })
})
