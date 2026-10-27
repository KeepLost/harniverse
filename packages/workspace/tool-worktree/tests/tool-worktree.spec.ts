import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Service } from '@deepseek-ai/cordis'
import type { CreatedWorktree, CreateWorktreeRequest } from '@deepseek-ai/dsh-worktree'
import * as toolWorktree from '@deepseek-ai/dsh-tool-worktree'

const signal = new AbortController().signal

/** Stub worktree owner recording the request it received. */
class StubWorktrees extends Service {
  requests: Array<CreateWorktreeRequest & { agent: Agent }> = []
  next: CreatedWorktree = { path: '/repo/.agents/worktrees/wt-1', branch: 'wt-1', baseCommit: 'a'.repeat(40), repositoryRoot: '/repo' }

  constructor(ctx: Context) {
    super(ctx, 'worktrees')
  }

  async create(agent: Agent, request: CreateWorktreeRequest = {}): Promise<CreatedWorktree> {
    this.requests.push({ ...request, agent })
    return this.next
  }
}

function stubAgent(): Agent {
  const session = Session.create(SessionId('s1'))
  const status: AgentStatus = 'running'
  return {
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
}

async function boot(): Promise<{ ctx: Context; stub: StubWorktrees }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubWorktrees)
  const stub = ctx.get('worktrees') as unknown as StubWorktrees
  await ctx.plugin(toolWorktree)
  return { ctx, stub }
}

async function run(ctx: Context, args: Record<string, unknown>, agent?: Agent): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    signal,
    callId: CallId('call-1'),
    name: 'create_worktree',
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

describe('create_worktree tool', () => {
  it('creates through the shared owner and renders the created facts', async () => {
    const { ctx, stub } = await boot()
    try {
      const agent = stubAgent()
      const result = await run(ctx, { name: 'feat', from: 'main' }, agent)
      expect(result.isError).toBe(false)
      expect(result.value).toEqual(stub.next)
      expect(stub.requests).toEqual([{ name: 'feat', from: 'main', agent }])
      const block = result.content[0]
      expect(block?.type).toBe('text')
      expect((block as { text?: string }).text).toBe(JSON.stringify(stub.next))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects agentless calls and removes its tool on fiber disposal (HMR-safety)', async () => {
    const { ctx } = await boot()
    try {
      expect((await run(ctx, {})).isError).toBe(true)
      const second = new Context()
      await second.plugin(SystemPrompt)
      await second.plugin(ToolRuntime)
      await second.plugin(StubWorktrees)
      const mounted = await second.plugin(toolWorktree)
      await mounted.dispose()
      expect(second.tools.schemas().some(schema => schema.name === 'create_worktree')).toBe(false)
      await second.fiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('presents the call with a stable title and the request as raw input', async () => {
    const { ctx } = await boot()
    try {
      const definition = ctx.tools.get('create_worktree')
      expect(definition?.presentCall?.({ name: 'feat' })).toEqual({ card: 'generic', title: 'create_worktree', rawInput: { name: 'feat' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
