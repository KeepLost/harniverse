import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import * as toolWorkingDirectory from '@deepseek-ai/dsh-tool-working-directory'

const signal = new AbortController().signal
const roots: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tool-working-directory-spec-'))
  roots.push(dir)
  return dir
}

function stubAgent(cwd?: string): Agent {
  const id = SessionId('s1')
  const session = Session.create(id, [], cwd === undefined ? undefined : { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  const status: AgentStatus = 'running'
  const agent: Agent = {
    id: SessionId('a1'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status,
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return agent
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(WorkingDirectoryService)
  await ctx.plugin(toolWorkingDirectory)
  return ctx
}

/** Execute the tool once through the real registry. */
async function run(ctx: Context, args: Record<string, unknown>, agent?: Agent): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    signal,
    callId: CallId('call-1'),
    name: 'working_directory',
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('working_directory tool', () => {
  it('reads the current directory through the service and validates the session start', async () => {
    const root = await tempDir()
    const ctx = await boot()
    try {
      const agent = stubAgent(root)
      const result = await run(ctx, {}, agent)
      expect(result.isError).toBe(false)
      expect(result.value).toEqual({ cwd: await (await import('node:fs/promises')).realpath(root) })
      expect(agent.session.events.filter(event => event.type === 'working-directory/change')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('changes the directory with cd and renders the canonical path', async () => {
    const root = await tempDir()
    const target = join(root, 'entered')
    const ctx = await boot()
    try {
      await (await import('node:fs/promises')).mkdir(target)
      const agent = stubAgent(root)
      const result = await run(ctx, { cd: 'entered' }, agent)
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      const block = result.content[0]
      expect(block?.type).toBe('text')
      expect((block as { text?: string }).text).toBe((result.value as { cwd: string }).cwd)
      expect(result.value).toEqual({ cwd: await (await import('node:fs/promises')).realpath(target) })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('surfaces a missing directory as a tool error and rejects agentless calls', async () => {
    const root = await tempDir()
    const ctx = await boot()
    try {
      const agent = stubAgent(root)
      const failure = await run(ctx, { cd: join(root, 'missing') }, agent)
      expect(failure.isError).toBe(true)
      const agentless = await run(ctx, {})
      expect(agentless.isError).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('renders the canonical path and presents the call', async () => {
    const ctx = await boot()
    try {
      const definition = ctx.tools.get('working_directory')
      expect(definition?.output.render({}, { cwd: '/repo' })).toEqual([{ type: 'text', text: '/repo' }])
      expect(definition?.presentCall?.({ cd: '/repo' })).toEqual({ card: 'generic', title: 'working_directory', rawInput: { cd: '/repo' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes its tool when the plugin fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(WorkingDirectoryService)
    const fiber = await ctx.plugin(toolWorkingDirectory)
    expect(ctx.tools.schemas().some(schema => schema.name === 'working_directory')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'working_directory')).toBe(false)
    await ctx.fiber.dispose()
  })
})
