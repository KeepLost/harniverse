import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SchedulerService from '@deepseek-ai/dsh-scheduler'
import * as SchedulerInvariant from '@deepseek-ai/dsh-scheduler/invariant'

/** Live state shared by the stub services the Loader composition mounts. */
interface StubState {
  session: Session
  agent?: Agent
  followups: UserMessage[]
  toolNames: string[]
  resets: number
}

function stubPlugin(state: StubState) {
  return {
    name: 'scheduler-composition-stubs',
    apply: (ctx: Context): void => {
      const signal = new AbortController().signal
      const agentOf = (): Agent => {
        if (state.agent === undefined) {
          state.agent = {
            id: state.session.id,
            session: state.session,
            options: {},
            status: 'idle',
            whenIdle: () => Promise.resolve(),
            followup: (message: UserMessage) => { state.followups.push(message) },
            runMaintenance: <T>(task: (agentSignal: AbortSignal) => Promise<T>): Promise<T> => task(signal),
          } as unknown as Agent
        }
        return state.agent
      }
      ctx.provide('agents', {
        get: (id: string) => (state.session !== undefined && id === state.session.id ? agentOf() : undefined),
        roots: () => (state.session === undefined ? [] : [agentOf()]),
        list: () => (state.session === undefined ? [] : [agentOf()]),
        isOwnedBy: () => false,
        create: async () => { throw new Error('not used in this composition') },
        resume: async () => { throw new Error('not used in this composition') },
        closeIfIdle: async () => 'busy' as const,
      })
      ctx.provide('tools', {
        register: (definition: { name: string }) => {
          state.toolNames.push(definition.name)
          return () => undefined
        },
      })
      ctx.provide('systemPrompt', {
        context: () => () => undefined,
      })
      ctx.provide('contextReset', {
        resetNow: async () => {
          state.resets += 1
          return null
        },
      })
    },
  }
}

let root: string | undefined
let contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot one Loader composition over the given storage root. */
async function boot(state: StubState): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  const configPath = join(root!, 'cordis.yml')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(configPath, [
    '- name: \'@deepseek-ai/dsh-session\'',
    '- name: \'@deepseek-ai/dsh-storage\'',
    '- name: \'@deepseek-ai/dsh-storage-json\'',
    '  config:',
    `    root: ${JSON.stringify(root!)}`,
    '- name: \'@deepseek-ai/dsh-storage-domain\'',
    '  config:',
    '    backend: json',
    '- name: \'@deepseek-ai/dsh-scheduler\'',
    '- name: \'scheduler-composition-stubs\'',
    '',
  ].join('\n'))
  context.baseUrl = pathToFileURL(root!).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-scheduler', SchedulerService],
    ['@deepseek-ai/dsh-scheduler/invariant', SchedulerInvariant],
    ['scheduler-composition-stubs', stubPlugin(state)],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('scheduler real Loader composition', () => {
  it('delivers a fresh-context schedule end to end and survives a restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduler-loader-'))
    const state: StubState = { session: undefined as never, followups: [], toolNames: [], resets: 0 }
    const context = await boot(state)
    const session = context.sessions.create(SessionId('scheduler-loader'))
    state.session = session

    expect(state.toolNames).toEqual(['schedule_create', 'schedule_list', 'schedule_delete'])
    expect(context.scheduler).toBeDefined()

    const record = await context.scheduler.create({
      prompt: 'run the nightly checklist',
      rule: { kind: 'after', delayMs: 1 },
      target: { kind: 'current' },
      contextMode: 'fresh',
      createdBy: { kind: 'user', sessionId: session.id },
    })
    expect(record.status).toBe('active')

    await vi.waitFor(() => {
      expect(state.followups).toHaveLength(1)
    }, { timeout: 5_000 })
    expect(state.resets).toBe(1)
    expect(state.followups[0]!.content).toEqual([{ type: 'text', text: 'run the nightly checklist' }])
    expect(state.followups[0]!.source).toEqual({ kind: 'plugin', plugin: 'schedule' })
    const dispatch = session.events.find(event => event.type === 'schedule/dispatch')
    expect(dispatch).toBeDefined()

    await vi.waitFor(async () => {
      const after = (context.scheduler.list()).find(row => row.id === record.id)
      expect(after?.status).toBe('done')
    }, { timeout: 5_000 })

    await context.fiber.dispose()
    contexts = contexts.filter(item => item !== context)

    const reborn: StubState = { session: undefined as never, followups: [], toolNames: [], resets: 0 }
    const second = await boot(reborn)
    const persisted = second.scheduler.list()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      id: record.id,
      status: 'done',
      prompt: 'run the nightly checklist',
    })
    expect(persisted[0]?.lastRunAt).toBeTypeOf('number')
  })
})
