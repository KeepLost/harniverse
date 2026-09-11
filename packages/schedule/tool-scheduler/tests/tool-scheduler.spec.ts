import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore, { Session, SessionId, type Session as SessionType } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SchedulerService from '@deepseek-ai/dsh-scheduler'
import { apply, inject, name } from '../src/index.ts'

interface Harness {
  readonly ctx: Context
  readonly definitions: Record<ToolName, ToolExecute>
}

type ToolName = 'schedule_create' | 'schedule_list' | 'schedule_delete'

interface ToolExecute {
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

async function harness(): Promise<{ test: Harness; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-scheduler-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('agents', {
    get: () => undefined,
    roots: () => [],
    list: () => [],
    isOwnedBy: () => false,
    create: async () => { throw new Error('not used in this suite') },
    resume: async () => { throw new Error('not used in this suite') },
    closeIfIdle: async () => 'busy' as const,
  } as never)

  const definitions = {} as Record<ToolName, ToolExecute>
  ctx.provide('tools', {
    register: (definition: { name: string }) => {
      if ((['schedule_create', 'schedule_list', 'schedule_delete'] as const).includes(definition.name as ToolName)) {
        definitions[definition.name as ToolName] = definition as unknown as ToolExecute
      }
      return () => undefined
    },
  } as never)

  await ctx.plugin(SchedulerService)
  expect(name).toBe('tool-scheduler')
  expect(inject).toEqual(['scheduler', 'tools'])
  await ctx.plugin({ name, inject, apply })

  return {
    test: { ctx, definitions },
    cleanup: async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** A live agent handle over one session of this suite. */
function agentOf(session: SessionType): Agent {
  return {
    id: session.id,
    session,
    options: {},
    status: 'idle',
    whenIdle: () => Promise.resolve(),
    followup: () => undefined,
    runMaintenance: <T>(task: (agentSignal: AbortSignal) => Promise<T>): Promise<T> =>
      task(new AbortController().signal),
  } as unknown as Agent
}

/** Rendered block shape used by the model-facing tool tests. */
interface RenderedBlock { type: string; text: string }

/** Project the render function out of one collected tool definition. */
function renderOf(definition: ToolExecute): (args: unknown, value: unknown) => RenderedBlock[] {
  const holder = definition as unknown as { output: { render: (args: unknown, value: unknown) => RenderedBlock[] } }
  return holder.output.render
}

afterEach(() => {
  void Session
})

describe('tool-scheduler unit composition', () => {
  it('schedule_create anchors recurrence and rejects ambiguous timing', async () => {
    const { test, cleanup } = await harness()
    try {
      const definitions = test.definitions
      expect(Object.keys(definitions)).toEqual(['schedule_create', 'schedule_list', 'schedule_delete'])
      const create = definitions.schedule_create
      const list = definitions.schedule_list
      const remove = definitions.schedule_delete

      const session = test.ctx.sessions.create(SessionId('tool-owner'))
      const exec = { agent: agentOf(session), signal: new AbortController().signal }
      interface CreateOutcome { scheduleId: string; target: string }
      interface ListRow { prompt: string; status: string }
      interface ListOutcome { schedules: ListRow[] }
      const created = await create.execute({
        prompt: 'weekly digest',
        after_minutes: 10,
        every_minutes: 5,
      }, exec) as CreateOutcome
      expect(created.scheduleId).toBeTypeOf('string')
      expect(created.target).toBe('current')

      const listed = await list.execute({}, exec) as ListOutcome
      expect(listed.schedules).toHaveLength(1)
      expect(listed.schedules[0]).toMatchObject({ prompt: 'weekly digest', status: 'active' })

      await expect(create.execute({
        prompt: 'both',
        run_at: '2026-09-09T00:00:00Z',
        after_minutes: 5,
      }, exec)).rejects.toThrow('exactly one')
      await expect(create.execute({ prompt: 'none' }, exec)).rejects.toThrow('one valid timing')

      const deleted = await remove.execute({ schedule_id: created.scheduleId }, exec) as { deleted: boolean }
      expect(deleted).toEqual({ deleted: true })
    } finally {
      await cleanup()
    }
  })

  it('requires a calling agent and renders model-facing output', async () => {
    const { test, cleanup } = await harness()
    try {
      const definitions = test.definitions
      await expect(definitions.schedule_create.execute({ prompt: 'x', after_minutes: 1 }, { signal: new AbortController().signal }))
        .rejects.toThrow('requires a calling agent')
      await expect(definitions.schedule_list.execute({}, { signal: new AbortController().signal }))
        .rejects.toThrow('requires a calling agent')
      await expect(definitions.schedule_delete.execute({ schedule_id: 'x' }, { signal: new AbortController().signal }))
        .rejects.toThrow('requires a calling agent')

      const session = test.ctx.sessions.create(SessionId('render-owner'))
      const exec = { agent: agentOf(session), signal: new AbortController().signal }
      await definitions.schedule_create.execute({
        prompt: 'absolute job run',
        run_at: '2099-01-01T00:00:00Z',
        target: 'job',
        context: 'fresh',
      }, exec)
      const created = await definitions.schedule_create.execute({
        prompt: 'rendered',
        after_minutes: 10,
      }, exec) as { scheduleId: string; nextDue: string; target: string }
      const createRender = renderOf(definitions.schedule_create)
      expect(createRender({ after_minutes: 10 }, created)[0]).toMatchObject({ type: 'text' })
      expect(createRender({ every_minutes: 5 }, created)[0]).toMatchObject({ type: 'text' })
      const listRender = renderOf(definitions.schedule_list)
      expect(listRender({}, { schedules: [] })[0]).toMatchObject({
        type: 'text',
        text: 'No scheduled tasks owned by this session.',
      })
      expect(listRender({}, {
        schedules: [{ scheduleId: created.scheduleId, prompt: 'rendered', status: 'active', nextDue: 'soon', target: 'current' }],
      })[0]).toMatchObject({ type: 'text' })
      const deleteRender = renderOf(definitions.schedule_delete)
      expect(deleteRender({ schedule_id: created.scheduleId }, { deleted: true })[0]).toMatchObject({ type: 'text' })
      expect(deleteRender({ schedule_id: 'missing' }, { deleted: false })[0]).toMatchObject({ type: 'text' })
    } finally {
      await cleanup()
    }
  })
})
