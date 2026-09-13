import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import GovernorService from '../src/index.ts'
import * as GovernorTool from '../src/tool.ts'
import type { GovernorInternals } from '../src/index.ts'
import type { CgroupInternals } from '../src/cgroup.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

/** Approval stub: a fixed policy and recorded requests with settable outcome. */
class ApprovalStub extends Service {
  readonly requests: { toolName: string; reason: string }[] = []
  outcome: 'allowed-once' | 'rejected' = 'allowed-once'

  constructor(ctx: Context, readonly policy: 'ask' | 'never') {
    super(ctx, 'approval')
  }

  effectivePolicy(): 'ask' | 'never' {
    return this.policy
  }

  async request(req: { toolName: string; reason: string }): Promise<string> {
    this.requests.push({ toolName: req.toolName, reason: req.reason })
    return this.outcome
  }
}

const deadCgroup: GovernorInternals['cgroup'] = {
  mkdir: async () => {},
  readFile: async () => {
    throw new Error('ENOENT')
  },
  writeFile: async () => {
    throw new Error('EROFS')
  },
  rmdir: async () => {},
  readDir: async () => [],
  accessWrite: async () => false,
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(policy: 'ask' | 'never' | 'none', memoryLimit = 10_000_000) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-governor-tool-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (policy !== 'none') {
    await ctx.plugin(class extends ApprovalStub {
      constructor(scope: Context) { super(scope, policy === 'ask' ? 'ask' : 'never') }
    })
  }
  const approval = ctx.get('approval') as unknown as ApprovalStub | undefined
  const session = ctx.sessions.create(SessionId('tool-session'))
  const agent = { id: session.id, session } as unknown as Agent
  ctx.provide('agents', {
    get: (id: string) => (id === session.id ? agent : undefined),
    list: () => [agent],
    roots: () => [agent],
  } as never)
  class G extends GovernorService {
    constructor(scope: Context) {
      super(scope, {
        ...DEFAULT_CONFIG,
        memory: { limit: memoryLimit },
        sampling: { baseMs: 3_600_000, hotMs: 3_600_000 },
      }, { cgroup: deadCgroup as CgroupInternals })
    }
  }
  await ctx.plugin(G)
  await ctx.plugin(GovernorTool)
  return { ctx, session, agent, approval }
}

let calls = 0
function call(ctx: Context, agent: Agent, arguments_: Record<string, unknown>) {
  calls += 1
  return ctx.tools.execute({ signal: new AbortController().signal, callId: CallId(`call-${calls}`), name: 'resource-quota', arguments: arguments_, agent })
}

describe('resource-quota tool', () => {
  it('reads the current quota state', async () => {
    const { ctx, agent } = await harness('never')
    const result = await call(ctx, agent, { action: 'get' })
    process.stdout.write(`TOOLDBG err=${String(result.isError)} content=${JSON.stringify(result.content).slice(0, 300)}\n`)
    expect(result.isError).toBe(false)
    expect(result.meta).toMatchObject({ kind: 'state', sessionId: 'tool-session', shared: true })
    await ctx.fiber.dispose()
  })

  it('lowers and clears without approval', async () => {
    const { ctx, agent, approval } = await harness('ask')
    const result = await call(ctx, agent, { action: 'set', memoryBytes: 4_000_000 })
    expect(result.meta).toEqual(expect.objectContaining({ kind: 'state', quotaBytes: 4_000_000, shared: false }))
    expect(approval?.requests).toHaveLength(0)
    const cleared = await call(ctx, agent, { action: 'set' })
    expect(cleared.meta).toEqual(expect.objectContaining({ kind: 'state', shared: true }))
    expect(approval?.requests).toHaveLength(0)
    void cleared
    await ctx.fiber.dispose()
  })

  it('raises freely under a never policy, clamped by admission', async () => {
    const { ctx, agent } = await harness('never', 10_000_000)
    const result = await call(ctx, agent, { action: 'set', memoryBytes: 50_000_000 })
    expect(result.meta).toMatchObject({ kind: 'state', quotaBytes: 10_000_000, clamped: true })
    await ctx.fiber.dispose()
  })

  it('raises without asking when no approval service is mounted', async () => {
    const { ctx, agent } = await harness('none', 200_000_000)
    // Establish a low explicit quota first; the raise afterwards skips the
    // approval gate entirely because no service is mounted.
    await call(ctx, agent, { action: 'set', memoryBytes: 70_000_000 })
    const result = await call(ctx, agent, { action: 'set', memoryBytes: 80_000_000 })
    expect(result.meta).toMatchObject({ kind: 'state', quotaBytes: 80_000_000 })
    await ctx.fiber.dispose()
  })

  it('asks once for a raise under an ask policy and honors rejection', async () => {
    const { ctx, agent, approval } = await harness('ask', 200_000_000)
    // Establish a low explicit quota first; 80M afterwards is a genuine raise.
    await call(ctx, agent, { action: 'set', memoryBytes: 70_000_000 })
    approval!.outcome = 'rejected'
    const rejected = await call(ctx, agent, { action: 'set', memoryBytes: 80_000_000 })
    expect(rejected.meta).toMatchObject({ kind: 'rejected' })
    expect(approval!.requests).toHaveLength(1)
    expect(ctx.governor.quotaStateOf('tool-session').quotaBytes).toBe(70_000_000)
    approval!.outcome = 'allowed-once'
    const allowed = await call(ctx, agent, { action: 'set', memoryBytes: 80_000_000 })
    expect(allowed.meta).toMatchObject({ kind: 'state', quotaBytes: 80_000_000 })
    expect(approval!.requests).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('rejects sub-floor raises and invalid input fails loud', async () => {
    const { ctx, agent } = await harness('never', 100_000_000)
    await call(ctx, agent, { action: 'set', memoryBytes: 10_000_000 })
    const result = await call(ctx, agent, { action: 'set', memoryBytes: 20_000_000 })
    expect(result.meta).toMatchObject({ kind: 'rejected' })
    const invalid = await call(ctx, agent, { action: 'set', memoryBytes: -1 })
    expect(invalid.isError).toBe(true)
    expect(JSON.stringify(invalid.content)).toContain('positive number')
    await ctx.fiber.dispose()
  })

  it('requires a session context', async () => {
    const { ctx } = await harness('never')
    const missing = await call(ctx, undefined as never, { action: 'get' })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('session context')
    await ctx.fiber.dispose()
  })
})
