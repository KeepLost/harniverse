/**
 * Unit tests for the management Remote: status projection across live,
 * absent, and disabled entries, the restart and probe pass-throughs with
 * their fleet-side validation errors, registered-row provenance, and the
 * fleet-changed notification over registry and handle change feeds.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { McpConnectionsService, McpProbeResult, SharedConnection } from '@deepseek-ai/dsh-mcp-client'
import { McpManagementService } from '../src/management.ts'
import type { UserMcpServerConfig } from '../src/index.ts'

function entry(overrides: Partial<UserMcpServerConfig> = {}): UserMcpServerConfig {
  return {
    id: 'alpha',
    enabled: true,
    transport: 'stdio',
    serverName: 'alpha',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    headers: {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    ...overrides,
  }
}

function fakeHandle(overrides: Partial<Pick<SharedConnection, 'status' | 'toolDescriptors'>> = {}): SharedConnection {
  const listeners = new Set<() => void>()
  return {
    serverName: 'alpha',
    ready: Promise.resolve({}),
    connected: () => true,
    status: overrides.status ?? (() => ({
      state: 'connected' as const,
      failedAttempts: 0,
      maxAttempts: 10,
      connectedAtMs: 1_000,
    })),
    toolDescriptors: overrides.toolDescriptors ?? (() => [
      { rawName: 'add', description: 'Adds numbers', inputSchema: { type: 'object' }, taskRequired: false },
    ]),
    toolNames: () => ['mcp__alpha__add'],
    resourceUris: () => [],
    resourceTemplates: () => [],
    instructions: () => '',
    callTool: () => Promise.resolve({}),
    resources: { request: () => Promise.resolve({}) },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      for (const listener of listeners) listener()
      return Promise.resolve()
    },
  }
}

/** Registry with a listener set the tests can fire like the real one. */
function registryOf(live: Record<string, SharedConnection>): McpConnectionsService & { notify(serverId: string): void } {
  const listeners = new Set<(serverId: string) => void>()
  const registry: McpConnectionsService & { notify(serverId: string): void } = {
    get: id => live[id],
    register: () => () => {},
    subscribe: (listener: (serverId: string) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify: (serverId: string) => { for (const listener of listeners) listener(serverId) },
  }
  return registry
}

describe('mcp management service', () => {
  it('projects live, absent, and disabled entries in settings order', async () => {
    const ctx = new Context()
    const live = fakeHandle()
    const rows = vi.fn(async () => {})
    void rows
    const service = new McpManagementService(ctx, {
      registry: registryOf({ alpha: live, missing: fakeHandle() }),
      entries: () => [
        { entry: entry(), registered: false },
        { entry: entry({ id: 'away', serverName: 'away', enabled: false }), registered: false },
        { entry: entry({ id: 'broken', serverName: 'broken', reconnect: {} }), registered: false },
      ],
      restartOwner: async () => { throw new Error('unreachable') },
      probeEntry: async () => { throw new Error('unreachable') },
    })
    const [alpha, away, broken] = service.status()
    expect(alpha).toMatchObject({
      id: 'alpha', serverName: 'alpha', transport: 'stdio', state: 'connected',
      failedAttempts: 0, maxAttempts: 10, connectedAtMs: 1_000,
      tools: [{ name: 'add', description: 'Adds numbers' }],
    })
    expect(alpha!.lastErrorKind).toBeUndefined()
    expect(alpha!.source).toBeUndefined()
    expect(away).toMatchObject({ id: 'away', state: 'disabled', tools: [], maxAttempts: 10 })
    // A configured server with no live handle reads stopped; the reconnect
    // fallback reports the default budget when the raw entry omits it.
    expect(broken).toMatchObject({ id: 'broken', state: 'stopped', tools: [], maxAttempts: 10 })
    void service
  })

  it('marks plugin-registered fleet entries with their provenance', () => {
    const ctx = new Context()
    const service = new McpManagementService(ctx, {
      registry: registryOf({ 'registered-extra': fakeHandle() }),
      entries: () => [
        { entry: entry({ id: 'registered-extra', serverName: 'extra' }), registered: true },
      ],
      restartOwner: async () => {},
      probeEntry: async () => { throw new Error('unreachable') },
    })
    expect(service.status()[0]).toMatchObject({ id: 'registered-extra', serverName: 'extra', state: 'connected' })
    expect(service.status()[0]!.source).toBe('registered')
  })

  it('carries the failure kind and outage counters of a retrying server', () => {
    const ctx = new Context()
    const service = new McpManagementService(ctx, {
      registry: registryOf({ flaky: fakeHandle({
        status: () => ({ state: 'reconnecting', failedAttempts: 3, maxAttempts: 7, lastErrorKind: 'TypeError' }),
      }) }),
      entries: () => [{ entry: entry({ id: 'flaky', serverName: 'flaky' }), registered: false }],
      restartOwner: async () => {},
      probeEntry: async () => { throw new Error('unreachable') },
    })
    expect(service.status()[0]).toMatchObject({
      id: 'flaky', state: 'reconnecting', failedAttempts: 3, maxAttempts: 7, lastErrorKind: 'TypeError',
    })
    expect(service.status()[0]!.connectedAtMs).toBeUndefined()
  })

  it('passes restart through to the fleet step', async () => {
    const ctx = new Context()
    const restarted: string[] = []
    const service = new McpManagementService(ctx, {
      registry: registryOf({}),
      entries: () => [{ entry: entry(), registered: false }],
      restartOwner: async (id) => { restarted.push(id) },
      probeEntry: async () => { throw new Error('unreachable') },
    })
    await service.restart('alpha')
    expect(restarted).toEqual(['alpha'])
  })

  it('passes probe through and surfaces an unknown server as a Remote failure', async () => {
    const ctx = new Context()
    const probed: string[] = []
    const outcome: McpProbeResult = { ok: true, toolNames: ['add'], truncated: false, durationMs: 1, cleanup: 'ok' }
    const service = new McpManagementService(ctx, {
      registry: registryOf({}),
      entries: () => [{ entry: entry({ id: 'away', serverName: 'away', enabled: false }), registered: false }],
      restartOwner: async () => {},
      probeEntry: async (id) => {
        probed.push(id)
        if (id !== 'away') throw new Error(`mcp-user-config: unknown server "${id}"`)
        return outcome
      },
    })
    await expect(service.probe('away')).resolves.toBe(outcome)
    expect(probed).toEqual(['away'])
    await expect(service.probe('ghost')).rejects.toThrow('unknown server "ghost"')
  })

  it('contains an ASYNC fleet-changed listener rejection instead of leaving it unhandled', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const rejecting = (): unknown => Promise.reject(new Error('async observer'))
      ctx.on('mcpManagement/fleet-changed', rejecting)
      const registry = registryOf({})
      new McpManagementService(ctx, {
        registry,
        entries: () => [],
        restartOwner: async () => {},
        probeEntry: async () => { throw new Error('unreachable') },
      })
      registry.notify('alpha')
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(unhandled).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith('mcpManagement: a fleet-changed listener failed')
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('rethrows the first INVARIANT-coded fleet-changed failure after notifying the rest', () => {
    const ctx = new Context()
    const later = vi.fn()
    ctx.on('mcpManagement/fleet-changed', () => {
      throw Object.assign(new Error('fleet incoherent'), { code: 'INVARIANT' })
    })
    ctx.on('mcpManagement/fleet-changed', later)
    const registry = registryOf({})
    const service = new McpManagementService(ctx, {
      registry,
      entries: () => [],
      restartOwner: async () => {},
      probeEntry: async () => { throw new Error('unreachable') },
    })
    expect(() => { registry.notify('alpha') }).toThrow('fleet incoherent')
    expect(later).toHaveBeenCalledTimes(1)
    void service
  })

  it('emits mcpManagement/fleet-changed on registry and handle changes with contained listeners', async () => {
    const ctx = new Context()
    const heard: string[] = []
    ctx.on('mcpManagement/fleet-changed', () => { throw new Error('broken listener') })
    ctx.on('mcpManagement/fleet-changed', () => { heard.push('fleet') })
    const handle = fakeHandle()
    const registry = registryOf({ alpha: handle })
    new McpManagementService(ctx, {
      registry,
      entries: () => [{ entry: entry(), registered: false }],
      restartOwner: async () => {},
      probeEntry: async () => { throw new Error('unreachable') },
    })
    // A handle's own change feed (state transition inside one connection).
    await handle.dispose()
    expect(heard).toEqual(['fleet'])
    // Registry membership/replacement (owner mount, unmount, restart).
    registry.notify('alpha')
    expect(heard).toEqual(['fleet', 'fleet'])
    await ctx.fiber.dispose()
    expect(heard).toEqual(['fleet', 'fleet'])
  })
})
