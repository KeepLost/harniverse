/** Browser frame/input I/O and multi-page memory benchmark. */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BrowserController } from '@deepseek-ai/dsh-api-browser-controller'
import type { BrowserAttachmentId, BrowserFrame, HostBrowserPageId } from '@deepseek-ai/dsh-api-browser-controller/types'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { chromium } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { collectGarbage, memorySample, median, percentile, rounded } from './../../../benchmarks/support/measurements.ts'
import { processTreeRssMb } from './../../../benchmarks/support/process-tree.ts'

const PAGE_COUNT = 4
const SAMPLES = 2
const INPUT_BUDGET_MS = 250
const FIRST_FRAME_BUDGET_MS = 2_000
const MAX_PROCESS_TREE_RSS_MB = 1_800

interface BrowserSample {
  readonly firstPageMs: number
  readonly additionalPageMs: number[]
  readonly firstFrameMs: number
  readonly inputAckMs: number
  readonly processTreeRssMb: number
  readonly retainedHeapMb: number
  readonly pageCount: number
}

let scratch = ''
let server: Server | undefined
let baseUrl = ''

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'harniverse-browser-benchmark-'))
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><input autofocus aria-label="benchmark input"><script>setInterval(() => document.body.dataset.tick = String(Date.now()), 16)</script>')
  })
  const httpServer = server
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('browser benchmark server did not bind')
  baseUrl = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  const httpServer = server
  if (httpServer !== undefined) {
    await new Promise<void>((resolve) => { httpServer.close(() => { resolve() }) })
  }
  if (scratch !== '') await rm(scratch, { recursive: true, force: true })
})

it('keeps multi-page browser I/O bounded in one Session browser', async () => {
  const samples: BrowserSample[] = []
  for (let index = 0; index < SAMPLES; index += 1) samples.push(await sample(index))
  const firstPages = samples.map(sample => sample.firstPageMs)
  const inputAcks = samples.map(sample => sample.inputAckMs)
  const firstFrames = samples.map(sample => sample.firstFrameMs)
  const report = {
    benchmark: 'browser-controller-multi-page-io',
    workload: { samples: SAMPLES, pageCount: PAGE_COUNT, viewport: { width: 640, height: 360 } },
    samples,
    aggregate: {
      firstPageMedianMs: rounded(median(firstPages)),
      firstFrameP95Ms: rounded(percentile(firstFrames, 0.95)),
      inputAckP95Ms: rounded(percentile(inputAcks, 0.95)),
      maxProcessTreeRssMb: rounded(Math.max(...samples.map(sample => sample.processTreeRssMb))),
      maxRetainedHeapMb: rounded(Math.max(...samples.map(sample => sample.retainedHeapMb))),
    },
    budgets: {
      firstFrameMs: FIRST_FRAME_BUDGET_MS,
      inputAckMs: INPUT_BUDGET_MS,
      processTreeRssMb: MAX_PROCESS_TREE_RSS_MB,
    },
  }
  process.stdout.write(`HARNIVERSE_BENCHMARK_RESULT ${JSON.stringify(report)}\n`)
  expect(report.aggregate.firstFrameP95Ms).toBeLessThanOrEqual(FIRST_FRAME_BUDGET_MS)
  expect(report.aggregate.inputAckP95Ms).toBeLessThanOrEqual(INPUT_BUDGET_MS)
  expect(report.aggregate.maxProcessTreeRssMb).toBeLessThanOrEqual(MAX_PROCESS_TREE_RSS_MB)
  expect(samples.every(sample => sample.pageCount === PAGE_COUNT)).toBe(true)
}, 120_000)

async function sample(index: number): Promise<BrowserSample> {
  const ctx = new Context()
  new LocalSubprocessRuntime(ctx)
  ctx.provide('sandboxPolicy', { workspaceRoot: scratch } as never)
  const controller = new BrowserController(ctx, {
    executablePath: chromium.executablePath(),
    browserCandidates: [],
    sandbox: 'auto',
    allowedHosts: ['127.0.0.1'],
    allowPrivateAddresses: true,
    maxPages: PAGE_COUNT,
    maxWidth: 640,
    maxHeight: 360,
    screencastQuality: 45,
    screencastEveryNthFrame: 1,
    navigationTimeoutMs: 10_000,
    launchTimeoutMs: 10_000,
    disposeGraceMs: 1_000,
  })
  const agent = {
    id: `browser-benchmark-session-${String(index)}`,
    ctx,
    session: { id: `browser-benchmark-session-${String(index)}`, header: { cwd: scratch } },
  } as unknown as Agent
  const signal = new AbortController().signal
  const pageIds = Array.from({ length: PAGE_COUNT }, (_, pageIndex) => `benchmark-page-${String(pageIndex)}` as HostBrowserPageId)
  const attachments = pageIds.map((_, pageIndex) => `benchmark-attachment-${String(pageIndex)}` as BrowserAttachmentId)
  const streams: AsyncIterator<BrowserFrame>[] = []
  const aborts: AbortController[] = []
  try {
    const firstStarted = performance.now()
    await controller.create(agent, { id: pageIds[0] as HostBrowserPageId, width: 640, height: 360 }, signal)
    const firstPageMs = performance.now() - firstStarted
    const firstAbort = new AbortController()
    const firstStream = controller.follow(
      agent, pageIds[0] as HostBrowserPageId, attachments[0] as BrowserAttachmentId, firstAbort.signal,
    )[Symbol.asyncIterator]()
    streams.push(firstStream)
    aborts.push(firstAbort)
    await firstStream.next()
    const firstFrameStarted = performance.now()
    await controller.navigate(agent, pageIds[0] as HostBrowserPageId, attachments[0] as BrowserAttachmentId, `${baseUrl}/?page=0`)
    await nextImage(firstStream)
    const firstFrameMs = performance.now() - firstFrameStarted
    const additionalPageMs: number[] = []
    for (let pageIndex = 1; pageIndex < PAGE_COUNT; pageIndex += 1) {
      const started = performance.now()
      await controller.create(agent, { id: pageIds[pageIndex] as HostBrowserPageId, width: 640, height: 360 }, signal)
      additionalPageMs.push(performance.now() - started)
    }
    const inputStarted = performance.now()
    await controller.input(agent, pageIds[0] as HostBrowserPageId, attachments[0] as BrowserAttachmentId, { kind: 'text', text: 'x' })
    const inputAckMs = performance.now() - inputStarted
    const treeRss = await processTreeRssMb(process.pid)
    collectGarbage()
    const retainedHeapMb = memorySample().heapUsedMb
    expect(controller.list(agent.session.id)).toHaveLength(PAGE_COUNT)
    await controller.close(agent, pageIds[0] as HostBrowserPageId)
    expect(controller.list(agent.session.id)).toHaveLength(PAGE_COUNT - 1)
    for (const pageId of pageIds.slice(1)) await controller.close(agent, pageId)
    expect(controller.list(agent.session.id)).toHaveLength(0)
    return {
      firstPageMs: rounded(firstPageMs),
      additionalPageMs: additionalPageMs.map(value => rounded(value)),
      firstFrameMs: rounded(firstFrameMs),
      inputAckMs: rounded(inputAckMs),
      processTreeRssMb: rounded(treeRss),
      retainedHeapMb,
      pageCount: PAGE_COUNT,
    }
  } finally {
    for (const abort of aborts) abort.abort()
    for (const stream of streams) await stream.return?.().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
}

async function nextImage(stream: AsyncIterator<BrowserFrame>): Promise<void> {
  for (;;) {
    const next = await stream.next()
    if (next.done) throw new Error('browser stream ended before an image frame')
    if (next.value.type === 'image' || next.value.type === 'snapshot' && next.value.image !== undefined) return
  }
}
