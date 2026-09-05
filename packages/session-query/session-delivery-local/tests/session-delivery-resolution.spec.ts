/**
 * Cold-session resolution, model-selection capture, and lifecycle guards of
 * the local delivery provider: every resume rung, sender authority checks,
 * and unload/create refusals.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  selection: undefined as ModelSelectionRef | undefined,
}))

vi.mock('@deepseek-ai/dsh-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-agent')>()
  return {
    ...actual,
    installModelSelection: (_agentCtx: unknown, selection: ModelSelectionRef): (() => void) => {
      captured.selection = selection
      return () => {}
    },
  }
})

import LocalSessionDelivery from '../src/index.ts'

function agent(id: string, origin: 'user' | 'subagent', followup = vi.fn()): Agent {
  return {
    id: SessionId(id),
    session: { header: { origin } },
    followup,
  } as unknown as Agent
}

function request(sender: Agent, targetSessionId: string) {
  return {
    sender,
    targetSessionId: SessionId(targetSessionId),
    content: [{ type: 'text' as const, text: 'continue' }],
    signal: new AbortController().signal,
  }
}

function header(id: string, extra: Record<string, unknown> = {}) {
  return { id: SessionId(id), createdAt: 1, origin: 'user', ...extra }
}

const requestHeaderEvent = {
  seq: 0,
  time: '2026-01-01T00:00:00.000Z',
  type: 'request/header',
  data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'epoch-start' },
}

describe('LocalSessionDelivery cold-session resolution', () => {
  it('routes an attached subagent session through the subagent service', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined } as never)
    ctx.provide('sessions', { get: () => ({ header: { origin: 'subagent' } }) } as never)
    const followup = vi.fn().mockResolvedValue('sub-message')
    ctx.provide('subagents', { followup } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'attached-sub'))).resolves.toEqual({
      accepted: true,
      messageId: 'sub-message',
    })
  })

  it('rejects an attached ordinary session without a live Agent', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined } as never)
    ctx.provide('sessions', { get: () => ({ header: { origin: 'user' } }) } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'attached'))).rejects.toThrow(
      'target session is attached without a live Agent',
    )
  })

  it('shares one cold resume across concurrent deliveries to the same target', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const resumed = agent('cold', 'user')
    const resume = vi.fn().mockImplementation(async (options: { setup: (ctx: unknown) => Promise<void> }) => {
      await options.setup({ agent: { session: { requestHeader: () => undefined } } })
      return { agent: resumed }
    })
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined, resume } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    let releaseInspect!: (value: unknown) => void
    const inspect = vi.fn(() => new Promise((resolve) => { releaseInspect = resolve }))
    ctx.provide('sessionPersistence', {
      list: async () => [header('cold')],
      inspect,
    } as never)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    const delivery = new LocalSessionDelivery(ctx)

    const deliveries = [delivery.deliver(request(sender, 'cold')), delivery.deliver(request(sender, 'cold'))]
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledOnce() })
    releaseInspect({ meta: header('cold'), events: [] })
    const receipts = await Promise.all(deliveries)

    expect(receipts.every(receipt => receipt.accepted)).toBe(true)
    expect(inspect).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
    expect(resume.mock.calls[0]![0]).toMatchObject({
      resumeSessionId: SessionId('cold'),
      agentOptions: { provider: 'p', model: 'm' },
    })
  })

  it('rejects a cold target when session persistence is not configured', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'cold'))).rejects.toThrow(
      'session persistence is not configured',
    )
  })

  it('rejects a cold target absent from the persisted session list', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('sessionPersistence', { list: async () => [], inspect: async () => ({ meta: header('cold'), events: [] }) } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'cold'))).rejects.toThrow(
      'target session was not found',
    )
  })

  it('routes a persisted subagent session through the subagent service', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [header('cold-sub', { origin: 'subagent' })],
      inspect: async () => ({ meta: header('cold-sub', { origin: 'subagent' }), events: [] }),
    } as never)
    const followup = vi.fn().mockResolvedValue('cold-sub-message')
    ctx.provide('subagents', { followup } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'cold-sub'))).resolves.toEqual({
      accepted: true,
      messageId: 'cold-sub-message',
    })
  })

  it('rejects a persisted session whose preset is unavailable', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [header('preset-session', { agentProfile: 'reviewer' })],
      inspect: async () => ({
        meta: header('preset-session', { agentProfile: 'reviewer' }),
        events: [requestHeaderEvent],
      }),
    } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'preset-session'))).rejects.toThrow(
      'target session preset is unavailable',
    )
  })

  it('rejects a cold target without a recorded or default model selection', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [header('modelless')],
      inspect: async () => ({ meta: header('modelless'), events: [] }),
    } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'modelless'))).rejects.toThrow(
      'target session has no recorded model and no deployment default is configured',
    )
  })

  it('mounts the resolved preset inside the resumed Agent scope', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const resumed = agent('preset-cold', 'user')
    const mount = vi.fn().mockResolvedValue(undefined)
    const scope = { agent: { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } } }
    const resume = vi.fn().mockImplementation(async (options: { setup: (ctx: unknown) => Promise<void> }) => {
      await options.setup(scope)
      return { agent: resumed }
    })
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined, resume } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [header('preset-cold', { agentProfile: 'reviewer' })],
      inspect: async () => ({
        meta: header('preset-cold', { agentProfile: 'reviewer' }),
        events: [requestHeaderEvent],
      }),
    } as never)
    ctx.provide('agentPresets', { mount } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'preset-cold'))).resolves.toMatchObject({
      accepted: true,
    })
    expect(mount).toHaveBeenCalledWith(scope, 'reviewer')
  })

  it('fails the resume when the setup scope carries no Agent', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const resume = vi.fn().mockImplementation(async (options: { setup: (ctx: unknown) => Promise<void> }) => {
      await options.setup(new Context())
      throw new Error('unreachable')
    })
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined, resume } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [header('scoped')],
      inspect: async () => ({ meta: header('scoped'), events: [requestHeaderEvent] }),
    } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'scoped'))).rejects.toThrow(
      'session delivery setup has no scoped Agent',
    )
  })

  it('falls back to the recorded resume selection when no live header exists', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const resumed = agent('recorded', 'user')
    const resume = vi.fn().mockImplementation(async (options: { setup: (ctx: unknown) => Promise<void> }) => {
      await options.setup({ agent: { session: { requestHeader: () => undefined } } })
      return { agent: resumed }
    })
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined, resume } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [header('recorded')],
      inspect: async () => ({ meta: header('recorded'), events: [requestHeaderEvent] }),
    } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'recorded'))).resolves.toMatchObject({
      accepted: true,
    })
    expect(captured.selection?.current).toEqual({ provider: 'p', model: 'm' })
  })

  it('derives the live selection from the resumed session header', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const resumed = agent('headered', 'user')
    let headerConfig: unknown = { provider: 'q', model: 'n' }
    const resume = vi.fn().mockImplementation(async (options: { setup: (ctx: unknown) => Promise<void> }) => {
      await options.setup({
        agent: { session: { requestHeader: () => ({ config: headerConfig }) } },
      })
      return { agent: resumed }
    })
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined, resume } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [header('headered')],
      inspect: async () => ({ meta: header('headered'), events: [requestHeaderEvent] }),
    } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'headered'))).resolves.toMatchObject({
      accepted: true,
    })
    expect(captured.selection?.current).toEqual({ provider: 'q', model: 'n' })
    expect(JSON.stringify(captured.selection?.current)).not.toContain('reasoningEffort')

    headerConfig = { provider: 'q', model: 'n', reasoningEffort: 'high' }
    const again = await delivery.deliver(request(sender, 'headered'))
    expect(again.accepted).toBe(true)
    expect(captured.selection?.current).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  })
})

describe('LocalSessionDelivery delivery guards', () => {
  it('requires the exact live sender Agent', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: () => agent('impostor', 'user') } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'anyone'))).rejects.toThrow(
      'session delivery requires the exact live sender Agent',
    )
  })

  it('refuses to deliver to the sender session itself', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: () => sender } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'parent'))).rejects.toThrow(
      'session delivery cannot target the sender session',
    )
  })

  it('refuses subagent delivery when the subagent service is not configured', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : undefined } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [header('cold-sub', { origin: 'subagent' })],
      inspect: async () => ({ meta: header('cold-sub', { origin: 'subagent' }), events: [] }),
    } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.deliver(request(sender, 'cold-sub'))).rejects.toThrow(
      'subagent delivery is not configured',
    )
  })
})

describe('LocalSessionDelivery unload guards', () => {
  const signal = new AbortController().signal

  function unloadRequest(sender: Agent, targetSessionId: string) {
    return { sender, targetSessionId: SessionId(targetSessionId), signal }
  }

  it('requires the exact live sender Agent', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: () => agent('impostor', 'user') } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.unload(unloadRequest(sender, 'anyone'))).rejects.toThrow(
      'session unload requires the exact live sender Agent',
    )
  })

  it('refuses to unload the sender session itself', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: () => sender } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.unload(unloadRequest(sender, 'parent'))).rejects.toThrow(
      'session unload cannot target the sender session',
    )
  })

  it('directs subagent targets to subagent lifecycle control', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const target = agent('child', 'subagent')
    ctx.provide('agents', { get: (id: SessionId) => id === sender.id ? sender : target } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.unload(unloadRequest(sender, 'child'))).rejects.toThrow(
      'target is a subagent session; use subagent lifecycle control',
    )
  })

  it('refuses a target runtime-owned by another Agent', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const target = agent('owned', 'user')
    const other = agent('runtime-owner', 'user')
    ctx.provide('agents', {
      get: (id: SessionId) => id === sender.id ? sender : target,
      list: () => [sender, target, other],
      isOwnedBy: (sessionId: SessionId, candidate: Agent) =>
        sessionId === target.id && candidate === other,
      closeIfIdle: vi.fn(),
    } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.unload(unloadRequest(sender, 'owned'))).rejects.toThrow(
      'target session is runtime-owned by another Agent',
    )
  })

  it('refuses a target that still owns a live child Agent', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const target = agent('owner', 'user')
    const child = agent('child-of-owner', 'user')
    ctx.provide('agents', {
      get: (id: SessionId) => id === sender.id ? sender : target,
      list: () => [sender, target, child],
      isOwnedBy: (sessionId: SessionId, candidate: Agent) =>
        sessionId === child.id && candidate === target,
      closeIfIdle: vi.fn(),
    } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.unload(unloadRequest(sender, 'owner'))).rejects.toThrow(
      'target session still owns a live child Agent',
    )
  })

  it('reports a target that detached before the unload acquired it', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    const target = agent('fleeting', 'user')
    ctx.provide('agents', {
      get: (id: SessionId) => id === sender.id ? sender : target,
      list: () => [sender, target],
      isOwnedBy: () => false,
      closeIfIdle: async () => 'not-found',
    } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.unload(unloadRequest(sender, 'fleeting'))).rejects.toThrow(
      'target session detached before unload acquired its lifecycle',
    )
  })
})

describe('LocalSessionDelivery create guards', () => {
  const signal = new AbortController().signal

  function createRequest(sender: Agent) {
    return { sender, signal }
  }

  it('requires the exact live sender Agent', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: () => agent('impostor', 'user') } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.create(createRequest(sender))).rejects.toThrow(
      'session creation requires the exact live sender Agent',
    )
  })

  it('refuses subagent senders', async () => {
    const ctx = new Context()
    const sender = agent('child', 'subagent')
    ctx.provide('agents', { get: () => sender } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.create(createRequest(sender))).rejects.toThrow(
      'subagents cannot create ordinary sessions',
    )
  })

  it('requires a deployment default model', async () => {
    const ctx = new Context()
    const sender = agent('parent', 'user')
    ctx.provide('agents', { get: () => sender } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    const delivery = new LocalSessionDelivery(ctx)

    await expect(delivery.create(createRequest(sender))).rejects.toThrow(
      'session creation requires a deployment default model',
    )
  })

  it('creates with the deployment default model and the sender workspace', async () => {
    const ctx = new Context()
    const sender = {
      id: SessionId('parent'),
      session: { header: { origin: 'user', cwd: '/workspace' } },
      followup: vi.fn(),
    } as unknown as Agent
    const create = vi.fn().mockResolvedValue(undefined)
    ctx.provide('agents', { get: () => sender, create } as never)
    ctx.provide('sessions', { get: () => undefined } as never)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    const delivery = new LocalSessionDelivery(ctx)

    const receipt = await delivery.create(createRequest(sender))

    expect(typeof receipt.sessionId).toBe('string')
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: { provider: 'p', model: 'm' },
      meta: { cwd: '/workspace' },
    }))
  })
})
