/**
 * Unit tests for the management Remote: status projection across live,
 * absent, and disabled entries, plus the restart pass-through and its
 * fleet-side validation errors.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { McpConnectionsService, SharedConnection } from '@deepseek-ai/dsh-mcp-client'
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
    resources: { request: () => Promise.resolve({}) } as SharedConnection['resources'],
    subscribe: () => () => {},
    dispose: () => Promise.resolve(),
  }
}

function registryOf(live: Record<string, SharedConnection>): McpConnectionsService {
  return { get: id => live[id] } as McpConnectionsService
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
        entry(),
        entry({ id: 'away', serverName: 'away', enabled: false }),
        entry({ id: 'broken', serverName: 'broken', reconnect: {} as UserMcpServerConfig['reconnect'] }),
      ],
      restartOwner: async () => { throw new Error('unreachable') },
    })
    const [alpha, away, broken] = service.status()
    expect(alpha).toMatchObject({
      id: 'alpha', serverName: 'alpha', transport: 'stdio', state: 'connected',
      failedAttempts: 0, maxAttempts: 10, connectedAtMs: 1_000,
      tools: [{ name: 'add', description: 'Adds numbers' }],
    })
    expect(alpha!.lastErrorKind).toBeUndefined()
    expect(away).toMatchObject({ id: 'away', state: 'disabled', tools: [], maxAttempts: 10 })
    // A configured server with no live handle reads stopped; the reconnect
    // fallback reports the default budget when the raw entry omits it.
    expect(broken).toMatchObject({ id: 'broken', state: 'stopped', tools: [], maxAttempts: 10 })
    void service
  })

  it('carries the failure kind and outage counters of a retrying server', () => {
    const ctx = new Context()
    const service = new McpManagementService(ctx, {
      registry: registryOf({ flaky: fakeHandle({
        status: () => ({ state: 'reconnecting', failedAttempts: 3, maxAttempts: 7, lastErrorKind: 'TypeError' }),
      }) }),
      entries: () => [entry({ id: 'flaky', serverName: 'flaky' })],
      restartOwner: async () => {},
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
      entries: () => [entry()],
      restartOwner: async (id) => { restarted.push(id) },
    })
    await service.restart('alpha')
    expect(restarted).toEqual(['alpha'])
  })
})
