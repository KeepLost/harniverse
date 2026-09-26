/** High-frequency PTY output benchmark through the production Bash backend. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import { BashTerminalBackend } from '@deepseek-ai/dsh-terminal-bash'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { collectGarbage, median, percentile, rounded } from './support/measurements.ts'

const SAMPLES = 3
const OUTPUT_BYTES = 512 * 1024
const SCROLLBACK_BYTES = 256 * 1024
const MAX_READ_BYTES = 64 * 1024
const DURATION_BUDGET_MS = 3_000
const HEARTBEAT_BUDGET_MS = 250
const RETAINED_HEAP_BUDGET_MB = 128

interface TerminalSample {
  readonly durationMs: number
  readonly heartbeatMaxDelayMs: number
  readonly retainedHeapMb: number
  readonly outputBytes: number
  readonly truncated: boolean
}

let scratch = ''

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'harniverse-terminal-benchmark-'))
})

afterAll(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true })
})

it('keeps high-frequency PTY output responsive and bounded', async () => {
  const samples: TerminalSample[] = []
  for (let index = 0; index < SAMPLES; index += 1) {
    samples.push(await sample(index))
  }

  const durations = samples.map(sample => sample.durationMs)
  const heartbeatDelays = samples.map(sample => sample.heartbeatMaxDelayMs)
  const retainedHeaps = samples.map(sample => sample.retainedHeapMb)
  const report = {
    benchmark: 'terminal-io',
    workload: {
      samples: SAMPLES,
      outputBytes: OUTPUT_BYTES,
      scrollbackBytes: SCROLLBACK_BYTES,
      maxReadBytes: MAX_READ_BYTES,
    },
    samples,
    aggregate: {
      durationMedianMs: rounded(median(durations)),
      durationP95Ms: rounded(percentile(durations, 0.95)),
      heartbeatMaxDelayMs: rounded(Math.max(...heartbeatDelays)),
      retainedHeapMaxMb: rounded(Math.max(...retainedHeaps)),
    },
    budgets: {
      durationMs: DURATION_BUDGET_MS,
      heartbeatMaxDelayMs: HEARTBEAT_BUDGET_MS,
      retainedHeapMb: RETAINED_HEAP_BUDGET_MB,
    },
  }
  process.stdout.write(`HARNIVERSE_BENCHMARK_RESULT ${JSON.stringify(report)}\n`)

  expect(report.aggregate.durationMedianMs).toBeLessThanOrEqual(DURATION_BUDGET_MS)
  expect(report.aggregate.heartbeatMaxDelayMs).toBeLessThanOrEqual(HEARTBEAT_BUDGET_MS)
  expect(report.aggregate.retainedHeapMaxMb).toBeLessThanOrEqual(RETAINED_HEAP_BUDGET_MB)
  expect(samples.every(sample => sample.outputBytes === MAX_READ_BYTES)).toBe(true)
  expect(samples.every(sample => sample.truncated)).toBe(true)
}, 120_000)

async function sample(index: number): Promise<TerminalSample> {
  const ctx = new Context()
  new LocalSubprocessRuntime(ctx)
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: scratch }),
  } as never)
  const agent = {
    id: `benchmark-agent-${String(index)}`,
    ctx,
    session: { id: `benchmark-session-${String(index)}`, header: { cwd: scratch } },
  } as unknown as Agent
  const backend = new BashTerminalBackend(ctx, {
    backendType: 'benchmark-shell',
    shellPath: '/bin/bash',
    shellArgs: ['--noprofile', '--norc', '-i'],
    rows: 40,
    cols: 160,
    scrollbackLines: 10_000,
    scrollbackMaxBytes: SCROLLBACK_BYTES,
    maxReadBytes: MAX_READ_BYTES,
    pollIntervalMs: 5,
    exactProbeAfterMs: 50,
    idleSilenceMs: 25,
    handoffGraceMs: 25,
    timeoutMs: 30_000,
    disposeGraceMs: 1_000,
  })
  let session: Awaited<ReturnType<typeof backend.spawn>> | undefined
  let heartbeat: NodeJS.Timeout | undefined
  try {
    session = await backend.spawn({
      owner: agent,
      sessionId: TerminalSessionId(`benchmark-terminal-${String(index)}`),
      cwd: scratch,
      type: 'benchmark-shell',
      signal: new AbortController().signal,
    })
    collectGarbage()
    const beforeHeap = process.memoryUsage().heapUsed
    let lastTick = performance.now()
    let heartbeatMaxDelay = 0
    heartbeat = setInterval(() => {
      const now = performance.now()
      heartbeatMaxDelay = Math.max(heartbeatMaxDelay, now - lastTick - 10)
      lastTick = now
    }, 10)
    const command = `head -c ${String(OUTPUT_BYTES)} /dev/zero | tr '\\0' x`
    const started = performance.now()
    const result = await session.startSend({ text: command, submit: true }).done
    const durationMs = performance.now() - started
    const read = session.read({ count: 10_000 })
    clearInterval(heartbeat)
    heartbeat = undefined
    collectGarbage()
    const retainedHeapMb = (process.memoryUsage().heapUsed - beforeHeap) / 1_048_576
    return {
      durationMs: rounded(durationMs),
      heartbeatMaxDelayMs: rounded(Math.max(0, heartbeatMaxDelay)),
      retainedHeapMb: rounded(retainedHeapMb),
      outputBytes: Buffer.byteLength(read.text),
      truncated: result.truncated && read.truncated,
    }
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    await session?.close('benchmark complete').catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
}
