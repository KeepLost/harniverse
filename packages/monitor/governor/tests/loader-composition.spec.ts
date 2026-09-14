import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import GovernorService from '../src/index.ts'
import * as GovernorTool from '../src/tool.ts'
import * as GovernorInvariant from '../src/invariant.ts'

/** Live state shared by the stub services the Loader composition mounts. */
interface StubState {
  session: Session
  followups: UserMessage[]
}

function stubPlugin(state: StubState) {
  return {
    name: 'governor-composition-stubs',
    apply: (ctx: Context): void => {
      const agentOf = (): Agent => {
        const agent = {
          id: state.session.id,
          session: state.session,
          options: {},
          status: 'idle',
          whenIdle: () => Promise.resolve(),
          followup: (message: UserMessage) => { state.followups.push(message) },
        } as unknown as Agent
        return agent
      }
      ctx.provide('agents', {
        get: (id: string) => (id === state.session.id ? agentOf() : undefined),
        roots: () => [agentOf()],
        list: () => [agentOf()],
        isOwnedBy: () => false,
        create: async () => { throw new Error('not used in this composition') },
        resume: async () => { throw new Error('not used in this composition') },
        closeIfIdle: async () => 'busy' as const,
      })
    },
  }
}

let root: string | undefined
const contexts: Context[] = []

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
    '- name: \'@deepseek-ai/dsh-system-prompt\'',
    '- name: \'@deepseek-ai/dsh-tools\'',
    '- name: \'@deepseek-ai/dsh-governor\'',
    '- name: \'@deepseek-ai/dsh-governor/tool\'',
    '- name: \'governor-composition-stubs\'',
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
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-governor', GovernorService],
    ['@deepseek-ai/dsh-governor/tool', GovernorTool],
    ['@deepseek-ai/dsh-governor/invariant', GovernorInvariant],
    ['governor-composition-stubs', stubPlugin(state)],
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

describe('governor real Loader composition', () => {
  it('mounts metering, the quota tool, and durable overrides end to end', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-governor-loader-'))
    const state: StubState = { session: undefined as never, followups: [] }
    const context = await boot(state)
    const session = context.sessions.create(SessionId('governor-loader'))
    state.session = session

    expect(context.governor).toBeDefined()
    expect(context.tools.get('resource-quota')).toBeDefined()

    // The overview answers with the resolved tier and global budget.
    const overview = context.governor.overview()
    expect(['cgroup', 'rlimit', 'observe']).toContain(overview.tier)
    expect(overview.globalLimitBytes).toBeGreaterThan(0)

    // A metered spawn joins the engine and settles out again.
    context.emit('subprocess/spawned', {
      correlation: { sessionId: session.id, commandId: 'comp-1', kind: 'shell' },
      handle: { pid: -1, terminate: () => {} },
    } as never)
    expect(context.governor.sessionSamples(session.id)).toHaveLength(1)
    context.emit('subprocess/exited', {
      correlation: { sessionId: session.id, commandId: 'comp-1', kind: 'shell' },
      handle: { pid: -1, terminate: () => {} },
      outcome: { exitCode: 0, signal: null },
    } as never)
    expect(context.governor.sessionSamples(session.id)[0]?.exitedAt).toBeDefined()

    // A quota decision lands durably and audits into the session log.
    await context.governor.adjustQuota(session.id, 512_000_000, 'board')
    expect(context.governor.quotaStateOf(session.id).quotaBytes).toBe(512_000_000)
    expect(session.events.some(event => event.type === 'governor/quota')).toBe(true)

    await context.fiber.dispose()
    contexts.splice(contexts.indexOf(context), 1)

    // Restart: the decided quota survives.
    const reborn: StubState = { session: undefined as never, followups: [] }
    const second = await boot(reborn)
    const resumed = second.sessions.create(SessionId('governor-loader'))
    reborn.session = resumed
    expect(second.governor.quotaStateOf(resumed.id).quotaBytes).toBe(512_000_000)
    // The resource-quota tool rides the composed ToolRuntime.
    expect(second.tools.get('resource-quota')).toBeDefined()
  })
})
