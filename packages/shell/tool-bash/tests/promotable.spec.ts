/** runPromotableForeground unit coverage: promotion, abort arms, and the adopted job callbacks. */

import { describe, expect, it, vi } from 'vitest'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { ShellExecRequest, ShellProcess, ShellProcessRead, ShellExecutor } from '@deepseek-ai/dsh-shell'
import { runPromotableForeground } from '../src/promotable.ts'

interface AdoptedRun {
  readonly cancel: () => void
  readonly done: Promise<{ status: string; detail: string }>
  readonly readOutput: () => string
}

/** A live process whose settlement the test controls. */
interface DeferredProcess extends ShellProcess {
  settle(status: 'completed' | 'killed', exitCode: number | null, signal: NodeJS.Signals | null): void
}

function deferredProcess(read: ShellProcessRead = { delta: 'out', lossy: false }): { process: DeferredProcess; kill: ReturnType<typeof vi.fn> } {
  const done = Promise.withResolvers<undefined>()
  const kill = vi.fn((): boolean => true)
  const process = {
    status: 'running',
    exitCode: null,
    signal: null,
    done: done.promise,
    kill,
    readOutput: vi.fn((): ShellProcessRead => read),
    settle: (status: 'completed' | 'killed', exitCode: number | null, signal: NodeJS.Signals | null): void => {
      process.status = status
      process.exitCode = exitCode
      process.signal = signal
      done.resolve(undefined)
    },
  } as DeferredProcess
  return { process, kill }
}

function fakeShell(process: ShellProcess, timeoutMs: number): ShellExecutor {
  return {
    resolve: vi.fn((request: ShellExecRequest) => ({ ...request, timeoutMs })),
    start: vi.fn(async () => process),
  } as unknown as ShellExecutor
}

function fakeJobs(): { registry: JobRegistry; adopted: { label: string; run: () => AdoptedRun }[] } {
  const adopted: { label: string; run: () => AdoptedRun }[] = []
  const registry = {
    start: (spec: { label: string; run: () => AdoptedRun }) => {
      adopted.push(spec)
      return `bash-${adopted.length}`
    },
  } as unknown as JobRegistry
  return { registry, adopted }
}

function inputs(shell: ShellExecutor, jobs: JobRegistry, signal: AbortSignal) {
  return {
    shell,
    request: { command: 'sleep 60' } as ShellExecRequest,
    signal,
    jobs,
    command: 'sleep 60',
    agent: undefined,
    escalationModes: [],
    abortedError: () => new Error('tool call aborted'),
    breach: undefined,
  }
}

describe('runPromotableForeground', () => {
  it('adopts the live process as a bash job on expiry with working callbacks', async () => {
    const { process, kill } = deferredProcess()
    const shell = fakeShell(process, 20)
    const { registry, adopted } = fakeJobs()
    const result = await runPromotableForeground(inputs(shell, registry, new AbortController().signal))
    expect(result).toEqual({ kind: 'timeout-background', jobId: 'bash-1', timeoutMs: 20 })
    expect(adopted).toHaveLength(1)
    expect(adopted[0]!.label).toBe('sleep 60')
    const run = adopted[0]!.run()
    expect(run.readOutput()).toContain('out')
    run.cancel()
    expect(kill).toHaveBeenCalledOnce()
    process.settle('completed', 0, null)
    expect(await run.done).toEqual({ status: 'completed', detail: 'exit code: 0' })
  })

  it('kills the process and rethrows the abort when the caller aborted before start', async () => {
    const { process, kill } = deferredProcess()
    const shell = fakeShell(process, 20)
    const { registry } = fakeJobs()
    const controller = new AbortController()
    controller.abort()
    await expect(runPromotableForeground(inputs(shell, registry, controller.signal))).rejects.toThrow('tool call aborted')
    expect(kill).toHaveBeenCalledOnce()
  })

  it('rethrows the abort when the process finishes after the caller aborted', async () => {
    const { process } = deferredProcess()
    const shell = fakeShell(process, 10_000)
    const { registry } = fakeJobs()
    const controller = new AbortController()
    const pending = runPromotableForeground(inputs(shell, registry, controller.signal))
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    process.settle('killed', null, 'SIGTERM')
    await expect(pending).rejects.toThrow('tool call aborted')
  })

  it('renders the ordinary foreground result for an in-budget completion', async () => {
    const { process } = deferredProcess({ delta: 'quick', lossy: false })
    process.settle('completed', 0, null)
    const shell = fakeShell(process, 10_000)
    const { registry } = fakeJobs()
    const result = await runPromotableForeground({
      ...inputs(shell, registry, new AbortController().signal),
      breach: { killed: 'governor', peakBytes: 10, limitBytes: 8 },
    })
    expect(result).toEqual({
      kind: 'foreground',
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 10_000,
      stdout: { text: 'quick', truncated: false },
      stderr: { text: '', truncated: false },
      governor: { killed: 'governor', peakBytes: 10, limitBytes: 8 },
    })
  })
})
