/**
 * sessions.shell / sessions.switchShell delegation. The session-shell face
 * is a stub service: this suite pins the API DELEGATION contract (payload in,
 * value out, service-missing and refused-switch error mapping), while the
 * service-level switching semantics (durable event, restriction swap,
 * capability read) live with the session-shell suite and the web-app bundle
 * composition tests.
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`fr-${String(nextRpc++)}`), payload }
}

/** Stub service answering a scripted capability and recording switches. */
class StubSessionShell extends Service {
  readonly switches: { sessionId: SessionId; family: 'bash' | 'pwsh' }[] = []

  constructor(
    ctx: Context,
    private readonly capability: { switchable: boolean; families: { bash: boolean; pwsh: boolean }; current?: 'bash' | 'pwsh' },
  ) {
    super(ctx, 'sessionShell')
  }

  family(): 'bash' | 'pwsh' {
    return this.capability.current ?? 'bash'
  }

  describe(): { switchable: boolean; families: { bash: boolean; pwsh: boolean } } {
    return this.capability
  }

  async switch(agent: Agent, family: 'bash' | 'pwsh'): Promise<'bash' | 'pwsh'> {
    if (!this.capability.switchable) {
      throw new Error('session-shell: this host composes a single shell executor; switching requires the shell router')
    }
    if (!this.capability.families[family]) {
      throw new Error(`session-shell: the ${family} shell family is unavailable on this host`)
    }
    this.switches.push({ sessionId: agent.session.id, family })
    this.capability.current = family
    return family
  }
}

async function composed(capability?: { switchable: boolean; families: { bash: boolean; pwsh: boolean }; current?: 'bash' | 'pwsh' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  if (capability !== undefined) new StubSessionShell(ctx, capability)
  ctx.agents.setFactory({
    createAgent: (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
      ctx.agents.register(agent)
      return Promise.resolve({ agent, dispose: () => Promise.resolve() })
    },
    resume: () => Promise.reject(new Error('resume must not run: every source is attached')),
  })
  return ctx
}

/** One live idle agent over a fresh stored session. */
function liveAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  const agent = { id: session.id, session, status: 'idle', ctx } as Agent
  ctx.agents.register(agent)
  return agent
}

const api = (ctx: Context) => createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

describe('sessions.shell', () => {
  it('answers the effective family and full availability on a routed host', async () => {
    const ctx = await composed({ switchable: true, families: { bash: true, pwsh: false }, current: 'bash' })
    try {
      const agent = liveAgent(ctx, 'session-shell-read')
      const proxy = api(ctx)
      const response = await proxy.sessions.shell?.(request({ sessionId: agent.session.id }))
      expect(response?.result).toEqual({
        ok: true,
        value: { current: 'bash', switchable: true, families: { bash: true, pwsh: false } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers the platform default with switchable false when the host composes no router', async () => {
    const ctx = await composed({ switchable: false, families: { bash: true, pwsh: false }, current: 'bash' })
    try {
      const agent = liveAgent(ctx, 'session-shell-single')
      const response = await api(ctx).sessions.shell?.(request({ sessionId: agent.session.id }))
      expect(response?.result).toEqual({
        ok: true,
        value: { current: 'bash', switchable: false, families: { bash: true, pwsh: false } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps a missing service to shell-unavailable', async () => {
    const ctx = await composed()
    try {
      const agent = liveAgent(ctx, 'session-shell-absent-service')
      const response = await api(ctx).sessions.shell?.(request({ sessionId: agent.session.id }))
      expect(response?.result).toEqual({
        ok: false,
        error: { code: 'shell-unavailable', message: 'session shell switching is not configured on this host', details: {} },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('sessions.switchShell', () => {
  it('switches through the service and answers the committed family', async () => {
    const ctx = await composed({ switchable: true, families: { bash: true, pwsh: true }, current: 'bash' })
    try {
      const agent = liveAgent(ctx, 'session-shell-switch')
      const proxy = api(ctx)
      const switched = await proxy.sessions.switchShell?.(request({ sessionId: agent.session.id, family: 'pwsh' }))
      expect(switched?.result).toEqual({ ok: true, value: { current: 'pwsh' } })
      const after = await proxy.sessions.shell?.(request({ sessionId: agent.session.id }))
      expect(after?.result).toEqual({
        ok: true,
        value: { current: 'pwsh', switchable: true, families: { bash: true, pwsh: true } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maps a refused family to shell-unavailable with the service message', async () => {
    const ctx = await composed({ switchable: true, families: { bash: true, pwsh: false }, current: 'bash' })
    try {
      const agent = liveAgent(ctx, 'session-shell-pwsh-missing')
      const refused = await api(ctx).sessions.switchShell?.(request({ sessionId: agent.session.id, family: 'pwsh' }))
      expect(refused?.result).toEqual({
        ok: false,
        error: { code: 'shell-unavailable', message: 'session-shell: the pwsh shell family is unavailable on this host', details: {} },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
