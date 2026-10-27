/** Cold restore and derivation of a large synthetic v0 session log. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION, type SessionHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { median, rounded } from './support/measurements.ts'

const SAMPLES = 3
/** Turns in the synthetic log; each turn is one user and one assistant message. */
const TURNS = 2_000
/** Characters of text per message body. */
const MESSAGE_CHARS = 400
/** Reference medians on the reference machine: restore ≈ 8 ms, derive ≈ 0.5 ms. */
const RESTORE_BUDGET_MS = 100
const DERIVE_BUDGET_MS = 25

interface Sample {
  readonly restoreMs: number
  readonly deriveMs: number
  readonly messages: number
}

let scratch = ''
let events: readonly SessionEvent[] = []
let header: SessionHeader

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'harniverse-session-open-benchmark-'))
  // The synthetic log is built once through the production append path, so the
  // restore samples fold real durable events, never hand-written JSON.
  const ctx = new Context()
  void new SessionStore(ctx)
  const session = ctx.sessions.create(SessionId('session-open-benchmark'))
  const body = '请继续分析这个模块，并给出下一步的修改建议。'.repeat(MESSAGE_CHARS / 20)
  const answer = '这个模块的职责是维护会话状态，建议下一步拆分投影逻辑。'.repeat(MESSAGE_CHARS / 24)
  for (let turn = 1; turn <= TURNS; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `第 ${String(turn)} 轮：${body}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', { message: createAssistantMessage({
      content: [{ type: 'text', text: `第 ${String(turn)} 轮回答：${answer}` }],
      source: { provider: 'mock', model: 'benchmark-model' },
    }), turn, step: 1 }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  events = [...session.events]
  header = { id: SessionId('session-open-benchmark'), version: SESSION_FORMAT_VERSION, createdAt: 1 }
  await ctx.fiber.dispose()
})

afterAll(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true })
})

it('restores a long session and derives its message history within budget', () => {
  const samples: Sample[] = []
  for (let index = 0; index < SAMPLES; index += 1) {
    const restoreStarted = performance.now()
    const session = Session.fromRestore(header.id, events, header)
    const restoreMs = performance.now() - restoreStarted
    const deriveStarted = performance.now()
    const messages = session.deriveMessages().length
    const deriveMs = performance.now() - deriveStarted
    samples.push({ restoreMs, deriveMs, messages })
  }

  const restores = samples.map(sample => sample.restoreMs)
  const derives = samples.map(sample => sample.deriveMs)
  const report = {
    benchmark: 'session-open',
    workload: { samples: SAMPLES, turns: TURNS, events: events.length, messageChars: MESSAGE_CHARS },
    samples,
    aggregate: {
      restoreMedianMs: rounded(median(restores)),
      deriveMedianMs: rounded(median(derives)),
      messages: samples[0]?.messages,
    },
    budgets: { restoreMs: RESTORE_BUDGET_MS, deriveMs: DERIVE_BUDGET_MS },
  }
  process.stdout.write(`HARNIVERSE_BENCHMARK_RESULT ${JSON.stringify(report)}\n`)

  expect(report.aggregate.restoreMedianMs).toBeLessThanOrEqual(RESTORE_BUDGET_MS)
  expect(report.aggregate.deriveMedianMs).toBeLessThanOrEqual(DERIVE_BUDGET_MS)
  expect(samples.every(sample => sample.messages === TURNS * 2)).toBe(true)
}, 180_000)
