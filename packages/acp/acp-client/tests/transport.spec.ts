/**
 * The stdio transport over the real subprocess seam: the teardown ladder
 * against real child processes, and the spawn failure and disposal contracts.
 */
import { describe, expect, it } from 'vitest'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'
import { AcpError } from '../src/index.ts'
import { DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, disposeAcpChild, spawnAcpChild } from '../src/transport.ts'
import { fakeSeam, FakeProcess } from './fake-agent.ts'

const node = (source: string, stdin: 'pipe' | 'ignore' = 'pipe') => spawnSubprocess({
  argv: [process.execPath, '--input-type=module', '--eval', source],
  cwd: process.cwd(),
  stdio: { stdin, stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } },
  graceMs: 200,
})

function expectHostTermination(outcome: SubprocessOutcome, posixSignal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    expect(outcome.signal).toBeNull()
    expect(outcome.exitCode).not.toBe(0)
  } else {
    expect(outcome.signal).toBe(posixSignal)
  }
}

describe('disposeAcpChild', () => {
  it('tier 1: a cooperative child exits on stdin EOF without any signal', async () => {
    const child = node('process.stdin.resume(); process.stdin.on("end", () => process.exit(0))')
    await disposeAcpChild(child, 5_000)
    const outcome = await child.done
    expect(outcome.exitCode).toBe(0)
    expect(outcome.signal).toBeNull()
  })

  it('tier 2: an EOF-deaf child reaches the host terminate outcome', async () => {
    const child = node('setInterval(() => {}, 60_000)')
    await disposeAcpChild(child, 100)
    expectHostTermination(await child.done, 'SIGTERM')
  })

  it('tier 3: a TERM-trapping child reaches the host force-termination outcome', async () => {
    const child = node('process.on("SIGTERM", () => {}); process.stdout.write("armed\\n"); setInterval(() => {}, 60_000)', 'ignore')
    // Wait for the trap to arm so SIGTERM cannot race the default handler.
    while (!child.collected.stdout!.readFrom(0).text.includes('armed')) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await disposeAcpChild(child, 50)
    expectHostTermination(await child.done, 'SIGKILL')
  })

  it('observes a spawn-level rejection and returns without a process to reap', async () => {
    const child = spawnSubprocess({
      argv: [process.execPath, '--input-type=module', '--eval', ''],
      cwd: '/nonexistent-dir-dsh-acp-ladder-test',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: { maxBytes: 1000 } },
      graceMs: 200,
    })
    await expect(disposeAcpChild(child, 1_000)).resolves.toBeUndefined()
    await expect(child.done).rejects.toThrow()
  })
})

/** Whether the promise settles within two seconds. */
async function settlesWithin(promise: Promise<void>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => { resolve(false) }, 2_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('spawnAcpChild', () => {
  const spawnReal = (source: string) => spawnAcpChild({
    definition: { command: process.execPath, args: ['--input-type=module', '--eval', source] },
    cwd: process.cwd(),
    spawn: spec => spawnSubprocess(spec),
    disposeEofGraceMs: 5_000,
    disposeGraceMs: 200,
  })

  it('exposes the protocol streams and settles exited once the agent left', async () => {
    const child = spawnReal('process.stdin.resume(); process.stdin.on("end", () => process.exit(7))')
    const first = child.dispose()
    expect(child.dispose()).toBe(first)
    await first
    expect(await child.exited).toEqual({ exitCode: 7, signal: null })
  })

  it('reports the output ending, by a broken pipe or by the disposal ladder', async () => {
    const broken = spawnReal('process.stdin.resume(); process.stdin.on("end", () => process.exit(0))')
    const ended = settlesWithin(broken.io.outputClosed)
    await broken.io.output.getWriter().abort()
    expect(await ended).toBe(true)
    await broken.dispose()

    const disposed = spawnReal('process.stdin.resume(); process.stdin.on("end", () => process.exit(0))')
    const ladder = settlesWithin(disposed.io.outputClosed)
    await disposed.dispose()
    expect(await ladder).toBe(true)
  })

  it('rejects failed once the process could not start', async () => {
    const child = spawnAcpChild({
      definition: { command: '/nonexistent-dir-dsh-acp-ladder-test/agent' },
      cwd: process.cwd(),
      spawn: spec => spawnSubprocess(spec),
      disposeEofGraceMs: 5_000,
      disposeGraceMs: 200,
    })
    const error = await child.failed.catch((caught: unknown) => caught as AcpError)
    expect(error).toMatchObject({ kind: 'spawn' })
    expect(error.message).toContain('the agent process failed to start')
    expect(await child.exited).toEqual({ exitCode: null, signal: null })
    await expect(child.dispose()).resolves.toBeUndefined()
  })

  it('describes a spawn failure that is not an Error', async () => {
    const child = spawnAcpChild({
      definition: { command: 'agent' },
      cwd: '/work',
      spawn: () => {
        const process = new FakeProcess()
        process.failSpawn('ENOENT: plain text')
        return process
      },
      disposeEofGraceMs: 20,
      disposeGraceMs: 20,
    })
    expect(await child.failed.catch((caught: unknown) => caught as AcpError)).toMatchObject({ kind: 'spawn', message: 'the agent process failed to start: ENOENT: plain text' })
  })

  it('passes the definition, the working directory, and the graces to the seam', () => {
    const specs: SubprocessSpawnSpec[] = []
    const processes: FakeProcess[] = []
    const seam = fakeSeam((process) => { processes.push(process) })
    const child = spawnAcpChild({
      definition: { command: 'agent', env: { TOKEN_EXPLICIT: 'kept' } },
      cwd: '/work',
      spawn: (spec) => {
        specs.push(spec)
        return seam.spawn(spec)
      },
      disposeEofGraceMs: DEFAULT_DISPOSE_EOF_GRACE_MS,
      disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    })
    expect(specs).toEqual([{
      argv: ['agent'],
      cwd: '/work',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3_000,
      env: { TOKEN_EXPLICIT: 'kept' },
    }])
    expect(processes[0]?.pid).toBeGreaterThan(0)
    expect(child.io.output).toBeInstanceOf(WritableStream)
    expect(child.io.input).toBeInstanceOf(ReadableStream)
  })
})
