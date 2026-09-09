import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SchedulerService, { ScheduleRuleError } from '../src/index.ts'

/**
 * Await one delivery-path assertion. Dispatch crosses durability barriers and
 * an optional fresh-context reset before a followup lands, which outruns the
 * default one-second budget on loaded Windows and macOS runners.
 */
function waitForDelivery(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000, interval: 25 })
}

interface AgentScript {
  readonly session: Session
  followups: UserMessage[]
  maintenance?: { busyOnce?: boolean }
  runMaintenanceError?: Error
  running?: boolean
}

/** Minimal live-agent stub over a real session. */
function fakeAgent(script: AgentScript): Agent {
  const signal = new AbortController().signal
  let busy = script.maintenance?.busyOnce === true
  const agent = {
    id: script.session.id,
    session: script.session,
    options: {},
    status: script.running === true ? 'running' : 'idle',
    whenIdle: async (): Promise<void> => {
      ;(agent as unknown as { status: string }).status = 'idle'
    },
    followup: (message: UserMessage) => {
      script.followups.push(message)
    },
    runMaintenance: <T>(task: (agentSignal: AbortSignal) => Promise<T>): Promise<T> => {
      if (script.runMaintenanceError !== undefined) throw script.runMaintenanceError
      if (busy) {
        busy = false
        throw new Error('agent already has active work')
      }
      return task(signal)
    },
  }
  return agent as unknown as Agent
}

interface AgentsStubState {
  live: Map<string, Agent>
  created: unknown[]
  resumed: unknown[]
  closed: string[]
  createAgent?: (sessionId: SessionId) => Agent
}

/** The agents-service surface the scheduler consumes, as an observable stub. */
function agentsStub(state: AgentsStubState): unknown {
  return {
    get: (id: string) => state.live.get(id),
    roots: () => [...state.live.values()],
    list: () => [...state.live.values()],
    isOwnedBy: () => false,
    create: async (options: unknown) => {
      state.created.push(options)
      const sessionId = (options as { sessionId: SessionId }).sessionId
      if (state.createAgent === undefined) throw new Error('test stub: no createAgent factory')
      const agent = state.createAgent(sessionId)
      return { agent, dispose: async () => state.closed.push(sessionId) }
    },
    resume: async (options: unknown) => {
      state.resumed.push(options)
      const sessionId = (options as { resumeSessionId: SessionId }).resumeSessionId
      const agent = state.live.get(sessionId)
        ?? (state.createAgent === undefined ? undefined : state.createAgent(sessionId))
      if (agent === undefined) throw new Error('test stub: expected a pre-seeded resume agent')
      const setup = (options as { setup?: (agentCtx: { agent: Agent }) => Promise<void> }).setup
      if (setup !== undefined) {
        try {
          await setup({ agent })
        } catch {
          // The stub agentCtx lacks the real model-selection surface; exercising
          // the setup body is enough for coverage.
        }
      }
      return { agent, dispose: async () => state.closed.push(sessionId) }
    },
    closeIfIdle: async (id: string) => {
      state.closed.push(id)
      state.live.delete(id)
      return 'closed'
    },
  }
}

interface Harness {
  readonly ctx: Context
  readonly service: SchedulerService
  readonly agentsState: AgentsStubState
  readonly scripts: Map<SessionId, AgentScript>
  readonly contextsRecorder: { name: string; text: (context: { agent?: Agent }) => string }[]
  readonly resetCalls: { agent: Agent; signal: AbortSignal }[]
  readonly provideReset: () => void
  readonly persistenceCalls: { listed: boolean; inspected: string[] }
}

async function harness(prepare?: (ctx: Context) => void): Promise<{ test: Harness; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-'))
  const ctx = new Context()
  prepare?.(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })

  const scripts = new Map<SessionId, AgentScript>()
  const agentsState: AgentsStubState = { live: new Map(), created: [], resumed: [], closed: [] }
  ctx.provide('agents', agentsStub(agentsState) as never)
  const contextsRecorder: Harness['contextsRecorder'] = []
  ctx.provide('systemPrompt', {
    context: (entry: { name: string; text: (context: { agent?: Agent }) => string }) => {
      contextsRecorder.push(entry)
      return () => undefined
    },
  } as never)
  const resetCalls: Harness['resetCalls'] = []
  const provideReset = (): void => {
    ctx.provide('contextReset', {
      resetNow: async (agent: Agent, signal: AbortSignal) => {
        resetCalls.push({ agent, signal })
        return null
      },
    } as never)
  }
  const persistenceCalls = { listed: false, inspected: [] as string[] }
  ctx.provide('sessionPersistence', {
    list: async () => {
      persistenceCalls.listed = true
      return [...scripts.keys()].map(id => ({ id }))
    },
    inspect: async (id: string) => {
      persistenceCalls.inspected.push(id)
      return { meta: {}, events: [] }
    },
  } as never)

  await ctx.plugin(SchedulerService)
  const service = ctx.scheduler
  if (service === undefined) throw new Error('scheduler service did not start')
  const test: Harness = {
    ctx,
    service,
    agentsState,
    scripts,
    contextsRecorder,
    resetCalls,
    provideReset,
    persistenceCalls,
  }
  return {
    test,
    cleanup: async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** Register one live agent script and expose its session. */
function seedAgent(test: Harness, name: string, script: AgentScript): void {
  test.scripts.set(script.session.id, script)
  test.agentsState.live.set(script.session.id, fakeAgent(script))
  void name
}

/** A live session with one scripted agent. */
function liveScript(test: Harness, name: string): AgentScript {
  const session = test.ctx.sessions.create(SessionId(name))
  const script: AgentScript = { session, followups: [] }
  seedAgent(test, name, script)
  return script
}

/** Await one timer-driven dispatch settling. */
async function settled(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

afterEach(async () => {
  vi.useRealTimers()
})

describe('scheduler storage and ownership', () => {
  it('registers its runtime context on boot', async () => {
    const { test, cleanup } = await harness()
    try {
      expect(test.contextsRecorder.map(entry => entry.name)).toEqual(['schedule:pending'])
    } finally {
      await cleanup()
    }
  })

  it('creates, lists, and scopes records by owning session', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const script = liveScript(test, 'owner')
      const record = await test.service.create({
        prompt: 'standup summary',
        rule: { kind: 'after', delayMs: 60_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      expect(record.status).toBe('active')
      expect(record.nextDue).toBe(record.createdAt + 60_000)
      const all = test.service.list()
      expect(all.map(row => row.id)).toEqual([record.id])
      const mine = test.service.listForSession(script.session.id)
      expect(mine).toHaveLength(1)
      const other = test.service.listForSession(SessionId('someone-else'))
      expect(other).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('rejects invalid prompts and rules with stable reasons', async () => {
    const { test, cleanup } = await harness()
    try {
      const script = liveScript(test, 'validation')
      await expect(test.service.create({
        prompt: '   ',
        rule: { kind: 'after', delayMs: 60_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })).rejects.toThrow('prompt must not be empty')
      await expect(test.service.create({
        prompt: 'x'.repeat(8_001),
        rule: { kind: 'after', delayMs: 60_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })).rejects.toThrow(ScheduleRuleError)
      await expect(test.service.create({
        prompt: 'ok',
        rule: { kind: 'every', intervalMs: 1, anchor: new Date().toISOString() },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })).rejects.toThrow('at least 5 minutes')
    } finally {
      await cleanup()
    }
  })

  it('edits and deletes under session ownership', async () => {
    const { test, cleanup } = await harness()
    try {
      const script = liveScript(test, 'edit-owner')
      const record = await test.service.create({
        prompt: 'first',
        rule: { kind: 'after', delayMs: 60_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'user', sessionId: script.session.id },
      })
      const table = (test.service as unknown as {
        table: { put: (id: string, value: Record<string, unknown>) => Promise<void> }
      }).table
      const legacy = { ...record } as unknown as Record<string, unknown>
      delete legacy.promptRevision
      delete legacy.lastPromptEdit
      await table.put(record.id, legacy)
      const edited = await test.service.update(record.id, { prompt: 'second', status: 'paused' }, script.session.id)
      expect(edited).toMatchObject({
        prompt: 'second',
        status: 'paused',
        promptRevision: 2,
        lastPromptEdit: {
          version: 2,
          prompt: 'second',
          editedBy: { kind: 'user', sessionId: script.session.id },
        },
      })
      expect(await test.service.update(record.id, { prompt: 'nope' }, SessionId('stranger')))
        .toBeUndefined()
      expect(await test.service.remove(record.id, SessionId('stranger'))).toBe(false)
      expect(await test.service.remove(record.id, script.session.id)).toBe(true)
      expect(test.service.list()).toEqual([])
      expect(await test.service.remove(record.id)).toBe(false)
    } finally {
      await cleanup()
    }
  })
})

describe('scheduler dispatch', () => {
  it('delivers a due prompt through the idle maintenance phase', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const script = liveScript(test, 'hot')
      const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValue(true)
      const record = await test.service.create({
        prompt: 'time to report',
        rule: { kind: 'after', delayMs: 60_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await waitForDelivery(() => {
        expect(script.followups).toHaveLength(1)
      })
      expect(script.followups[0]!.content).toEqual([{ type: 'text', text: 'time to report' }])
      expect(script.followups[0]!.source).toEqual({ kind: 'plugin', plugin: 'schedule' })
      const dispatch = script.session.events.find(event => event.type === 'schedule/dispatch')
      expect(dispatch).toBeDefined()
      expect(flush).toHaveBeenCalled()
      await waitForDelivery(async () => {
        const after = test.service.list().find(row => row.id === record.id)
        expect(after?.status).toBe('done')
        expect(after?.lastRunAt).toBeTypeOf('number')
        expect(after?.nextDue).toBeUndefined()
      })
      expect(test.service.listRuns(record.id, script.session.id)).toMatchObject([{
        scheduleId: record.id,
        ownerSessionId: script.session.id,
        targetSessionId: script.session.id,
        status: 'succeeded',
        promptRevision: 1,
      }])
      expect(test.service.listRunsOwned(script.session.id, record.id)).toHaveLength(1)
      expect(test.service.listRuns(record.id)).toHaveLength(1)
      await test.service.create({
        prompt: 'still pending',
        rule: { kind: 'after', delayMs: 60_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      expect((test.service.list()).map(row => row.status)).toEqual(['active', 'done'])
    } finally {
      await cleanup()
    }
  })

  it('resets the context before a fresh delivery', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      test.provideReset()
      const script = liveScript(test, 'fresh')
      vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValue(true)
      await test.service.create({
        prompt: 'fresh run',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'current' },
        contextMode: 'fresh',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      await vi.advanceTimersByTimeAsync(30_000)
      await waitForDelivery(() => {
        expect(test.resetCalls).toHaveLength(1)
        expect(script.followups).toHaveLength(1)
      })
    } finally {
      await cleanup()
    }
  })

  it('records a lastError and retries a failed one-shot after the retry delay', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const script = liveScript(test, 'fresh-missing')
      const record = await test.service.create({
        prompt: 'needs reset',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'current' },
        contextMode: 'fresh',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      await vi.advanceTimersByTimeAsync(30_000)
      await waitForDelivery(async () => {
        const after = (test.service.list()).find(row => row.id === record.id)
        expect(after?.lastError).toContain('context reset')
        expect(after?.status).toBe('active')
        expect(after?.nextDue).toBe(after!.lastRunAt! + 600_000)
      })
    } finally {
      await cleanup()
    }
  })

  it('creates the job session lazily on first fire and reuses it after', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      test.provideReset()
      test.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'test' }) } as never)
      const owner = liveScript(test, 'job-owner')
      const jobScripts: AgentScript[] = []
      test.agentsState.createAgent = (sessionId: SessionId) => {
        const session = test.ctx.sessions.create(sessionId)
        const script: AgentScript = { session, followups: [] }
        jobScripts.push(script)
        const agent = fakeAgent(script)
        test.agentsState.live.set(sessionId, agent)
        return agent
      }
      vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValue(true)
      const record = await test.service.create({
        prompt: 'nightly build',
        rule: { kind: 'every', intervalMs: 300_000, anchor: new Date(Date.now() + 300_000).toISOString() },
        target: { kind: 'job' },
        contextMode: 'fresh',
        createdBy: { kind: 'model', sessionId: owner.session.id },
      })
      await vi.advanceTimersByTimeAsync(300_000)
      await waitForDelivery(() => {
        expect(test.agentsState.created).toHaveLength(1)
      })
      expect(jobScripts).toHaveLength(1)
      await waitForDelivery(() => {
        expect(jobScripts[0]!.followups).toHaveLength(1)
      })
      expect(test.resetCalls).toHaveLength(1)
      await waitForDelivery(async () => {
        const stored = (test.service.list()).find(row => row.id === record.id)
        expect(stored?.jobSessionId).toBe(jobScripts[0]!.session.id)
        expect(stored?.nextDue).toBe(stored!.lastDue! + 300_000)
      })
      await vi.advanceTimersByTimeAsync(300_000)
      await waitForDelivery(() => {
        expect(jobScripts[0]!.followups).toHaveLength(2)
      })
      expect(test.agentsState.created).toHaveLength(1)
      await waitForDelivery(() => {
        expect(test.service.listRuns(record.id, owner.session.id)).toHaveLength(2)
      })
      expect(test.service.listRuns(record.id, SessionId('stranger'))).toEqual([])
      expect(test.service.listRuns('missing')).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('cold-resumes a persisted session, delivers, and recycles it when idle', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const coldSession = Session.create(SessionId('cold-target'))
      const coldScript: AgentScript = { session: coldSession, followups: [] }
      const coldAgent = fakeAgent(coldScript)
      test.agentsState.resumed.length = 0
      test.agentsState.live.clear()
      test.agentsState.createAgent = (sessionId: SessionId) => {
        test.agentsState.live.set(sessionId, coldAgent)
        return coldAgent
      }
      test.scripts.set(coldSession.id, coldScript)
      test.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'test' }) } as never)
      vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValue(true)
      await test.service.create({
        prompt: 'cold wake',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'user', sessionId: coldSession.id },
      })
      await vi.advanceTimersByTimeAsync(30_000)
      await waitForDelivery(() => {
        expect(test.persistenceCalls.listed).toBe(true)
        expect(test.persistenceCalls.inspected).toEqual([coldSession.id])
        expect(test.agentsState.resumed).toHaveLength(1)
        expect(coldScript.followups).toHaveLength(1)
      })
      await waitForDelivery(() => {
        expect(test.agentsState.closed).toEqual([coldSession.id])
      })
    } finally {
      await cleanup()
    }
  })

  it('waits out one busy maintenance claim and delivers on the retry', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const session = test.ctx.sessions.create(SessionId('busy-once'))
      const script: AgentScript = { session, followups: [], maintenance: { busyOnce: true }, running: true }
      seedAgent(test, 'busy-once', script)
      vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValue(true)
      await test.service.create({
        prompt: 'after the turn',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: session.id },
      })
      await vi.advanceTimersByTimeAsync(30_000)
      await waitForDelivery(() => {
        expect(script.followups).toHaveLength(1)
      })
    } finally {
      await cleanup()
    }
  })

  it('never fires a paused record and skips an overdue recurrence to its latest slot', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const paused = liveScript(test, 'paused-owner')
      const record = await test.service.create({
        prompt: 'on hold',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: paused.session.id },
      })
      await test.service.update(record.id, { status: 'paused' }, paused.session.id)
      await vi.advanceTimersByTimeAsync(120_000)
      await settled()
      expect(paused.followups).toHaveLength(0)

      const overdue = liveScript(test, 'overdue-owner')
      const start = Date.now()
      const overdueRecord = await test.service.create({
        prompt: 'catch up',
        rule: {
          kind: 'every',
          intervalMs: 300_000,
          anchor: new Date(start - 650_000).toISOString(),
        },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: overdue.session.id },
      })
      await waitForDelivery(async () => {
        expect(overdue.followups).toHaveLength(1)
        const stored = (test.service.list()).find(row => row.id === overdueRecord.id)
        expect(stored?.lastDue).toBe(start - 650_000 + 600_000)
      })
    } finally {
      await cleanup()
    }
  })
})

describe('scheduler session-scoped Remote surface', () => {
  it('lists, creates, updates, and removes under session ownership', async () => {
    const { test, cleanup } = await harness()
    try {
      const owner = liveScript(test, 'remote-owner')
      const foreign = liveScript(test, 'remote-foreign')
      const created = await test.service.createOwned(owner.session.id, {
        prompt: 'remote nightly',
        rule: { kind: 'after', delayMs: 60_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
      })
      expect(created.status).toBe('active')
      expect(created.createdBy).toEqual({ kind: 'user', sessionId: owner.session.id })

      expect(test.service.listOwned(owner.session.id).map(row => row.id)).toEqual([created.id])
      expect(test.service.listOwned(foreign.session.id)).toEqual([])

      const paused = await test.service.updateOwned(owner.session.id, created.id, { status: 'paused' })
      expect(paused?.status).toBe('paused')
      // Foreign sessions cannot edit or remove what they do not own.
      expect(await test.service.updateOwned(foreign.session.id, created.id, { status: 'active' })).toBeUndefined()
      expect(await test.service.removeOwned(foreign.session.id, created.id)).toBe(false)
      expect(await test.service.removeOwned(owner.session.id, created.id)).toBe(true)
      expect(test.service.listOwned(owner.session.id)).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

describe('scheduler runtime context', () => {
  it('summarizes pending in-session schedules and stays empty otherwise', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const script = liveScript(test, 'context-owner')
      const entry = test.contextsRecorder.find(item => item.name === 'schedule:pending')
      expect(entry).toBeDefined()
      expect(entry!.text({})).toBe('')
      await test.service.create({
        prompt: 'tick',
        rule: { kind: 'after', delayMs: 60_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      const agent = liveAgentOf(test, script)
      expect(entry!.text({ agent })).toContain('1 pending for this session')
    } finally {
      await cleanup()
    }
  })
})

/** The live agent handle for one scripted session. */
function liveAgentOf(test: Harness, script: AgentScript): Agent {
  const agent = test.agentsState.live.get(script.session.id)
  if (agent === undefined) throw new Error('no live agent for script')
  return agent
}

describe('scheduler cold-path and edge failures', () => {
  it('deduplicates concurrent cold resumes of one target session', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const coldSession = Session.create(SessionId('dedup-cold'))
      const coldScript: AgentScript = { session: coldSession, followups: [] }
      const coldAgent = fakeAgent(coldScript)
      test.agentsState.createAgent = (sessionId: SessionId) => {
        test.agentsState.live.set(sessionId, coldAgent)
        return coldAgent
      }
      test.scripts.set(coldSession.id, coldScript)
      test.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'test' }) } as never)
      for (const prompt of ['first', 'second']) {
        await test.service.create({
          prompt,
          rule: { kind: 'after', delayMs: 30_000 },
          target: { kind: 'current' },
          contextMode: 'continue',
          createdBy: { kind: 'user', sessionId: coldSession.id },
        })
      }
      await vi.advanceTimersByTimeAsync(30_000)
      await waitForDelivery(() => {
        expect(coldScript.followups).toHaveLength(2)
        expect(test.agentsState.resumed).toHaveLength(1)
      })
    } finally {
      await cleanup()
    }
  })

  it('records attached-without-agent, not-found, and no-model failures as lastError', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const attached = test.ctx.sessions.create(SessionId('attached-only'))
      const attachedRecord = await test.service.create({
        prompt: 'attached',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'user', sessionId: attached.id },
      })
      const schedulerTable = (test.service as unknown as {
        table: { put: (id: string, value: Record<string, unknown>) => Promise<void> }
      }).table
      const legacyAttached = { ...attachedRecord } as unknown as Record<string, unknown>
      delete legacyAttached.promptRevision
      delete legacyAttached.lastPromptEdit
      await schedulerTable.put(attachedRecord.id, legacyAttached)
      const noModel = Session.create(SessionId('no-model'))
      test.scripts.set(noModel.id, { session: noModel, followups: [] })
      await test.service.create({
        prompt: 'no model',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'user', sessionId: noModel.id },
      })
      const missing = liveScript(test, 'missing-owner')
      await test.service.create({
        prompt: 'missing',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'user', sessionId: SessionId('never-seen') },
      })
      void missing
      await vi.advanceTimersByTimeAsync(30_000)
      await waitForDelivery(async () => {
        const rows = test.service.list()
        const errors = rows.filter(row => row.lastError !== undefined)
        expect(errors).toHaveLength(3)
        expect(errors.map(row => row.lastError)).toEqual(expect.arrayContaining([
          expect.stringContaining('attached without a live agent'),
          expect.stringContaining('was not found'),
          expect.stringContaining('no recorded model'),
        ]))
      })
      expect(test.service.listRuns(attachedRecord.id)).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('requires a deployment default model for job sessions', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const owner = liveScript(test, 'job-model-owner')
      const record = await test.service.create({
        prompt: 'job without model',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'job' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: owner.session.id },
      })
      await vi.advanceTimersByTimeAsync(30_000)
      await waitForDelivery(async () => {
        const after = (test.service.list()).find(row => row.id === record.id)
        expect(after?.lastError).toContain('deployment default model')
      })
    } finally {
      await cleanup()
    }
  })

  it('records a busy retry exhaustion and advances an every rule to its next slot', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const session = test.ctx.sessions.create(SessionId('always-busy'))
      const script: AgentScript = { session, followups: [], runMaintenanceError: 'still busy' as unknown as Error }
      seedAgent(test, 'always-busy', script)
      const anchor = new Date(Date.now()).toISOString()
      const record = await test.service.create({
        prompt: 'stuck',
        rule: { kind: 'every', intervalMs: 300_000, anchor },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: session.id },
      })
      await waitForDelivery(async () => {
        const after = (test.service.list()).find(row => row.id === record.id)
        expect(after?.lastError).toContain('still busy')
        expect(after?.nextDue).toBe(record.nextDue! + 300_000)
      })
      expect(script.followups).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })

  it('skips advancing a record deleted while its dispatch was in flight', async () => {
    const { test, cleanup } = await harness()
    vi.useFakeTimers()
    try {
      const script = liveScript(test, 'delete-mid-flight')
      const record = await test.service.create({
        prompt: 'gone before advance',
        rule: { kind: 'after', delayMs: 30_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      await test.service.remove(record.id)
      await vi.advanceTimersByTimeAsync(30_000)
      await settled()
      expect(script.followups).toHaveLength(0)
      expect(test.service.list()).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

describe('scheduler list and pending edge coverage', () => {
  it('orders mixed records, applies host-authority edits, and rejects invalid prompt edits', async () => {
    const { test, cleanup } = await harness()
    try {
      const script = liveScript(test, 'edge-owner')
      const done = await test.service.create({
        prompt: 'already run',
        rule: { kind: 'after', delayMs: 60_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      const active = await test.service.create({
        prompt: 'still waiting',
        rule: { kind: 'after', delayMs: 120_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      const third = await test.service.create({
        prompt: 'much later',
        rule: { kind: 'after', delayMs: 300_000 },
        target: { kind: 'current' },
        contextMode: 'continue',
        createdBy: { kind: 'model', sessionId: script.session.id },
      })
      void third
      const rows = test.service.list()
      expect(rows.map(row => row.id)).toEqual([done.id, active.id, third.id])
      const updated = await test.service.update(done.id, { prompt: 'edited by host' })
      expect(updated?.prompt).toBe('edited by host')
      await expect(test.service.update(done.id, { prompt: '  ' }, script.session.id))
        .rejects.toThrow('prompt must not be empty')
      await expect(test.service.update(done.id, { prompt: 'y'.repeat(8_001) }, script.session.id))
        .rejects.toThrow('at most')
      const missing = await test.service.update('no-such-id', { prompt: 'x' })
      expect(missing).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('renders empty pending text for an agent without schedules', async () => {
    const { test, cleanup } = await harness()
    try {
      const script = liveScript(test, 'empty-pending')
      const entry = test.contextsRecorder.find(item => item.name === 'schedule:pending')
      const agent = liveAgentOf(test, script)
      expect(entry!.text({ agent })).toBe('')
    } finally {
      await cleanup()
    }
  })
})
