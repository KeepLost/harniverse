/**
 * Captured-generation lifecycle against a scripted mcp-client: streamable HTTP
 * mapping, startup failure containment, generation pinning, and quiescent
 * disposal.
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserMcpServerConfig } from '../src/index.ts'
import * as bridgeModule from '../src/index.ts'

const control = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  configErrorFor: undefined as string | undefined,
  configErrorValue: undefined as unknown,
  applyGate: undefined as Promise<undefined> | undefined,
  disposeGate: undefined as Promise<undefined> | undefined,
}))

vi.mock('@deepseek-ai/dsh-mcp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client')>()
  const actualStandard = (actual.Config as unknown as {
    '~standard': { validate: (config: unknown) => unknown }
  })['~standard']
  const callable = (config: unknown): unknown => actual.Config(config as never)
  return {
    ...actual,
    Config: Object.assign(callable, {
      '~standard': {
        validate: (config: unknown) => {
          const entry = config as { serverName?: string }
          if (entry.serverName === control.configErrorFor) {
            control.configErrorFor = undefined
            throw control.configErrorValue
          }
          return actualStandard.validate(config)
        },
      },
    }) as unknown as typeof actual.Config,
    apply: async (ctx: Context, config: unknown): Promise<void> => {
      control.configs.push(config as Record<string, unknown>)
      ctx.effect(async () => {
        if (control.applyGate !== undefined) await control.applyGate
        return async () => {
          if (control.disposeGate !== undefined) await control.disposeGate
        }
      })
    },
  }
})

class MemorySettings extends SettingsProvider {
  override readonly writable = true
  private rawDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.rawDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.rawDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

function server(id: string, overrides: Partial<UserMcpServerConfig> = {}): UserMcpServerConfig {
  return {
    id,
    enabled: true,
    transport: 'stdio',
    serverName: id,
    command: process.execPath,
    args: [],
    env: {},
    cwd: process.cwd(),
    headers: {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    ...overrides,
  }
}

const bridges: Array<Fiber & PromiseLike<Fiber>> = []
let settingsOwner: Fiber & PromiseLike<Fiber> | undefined

afterEach(async () => {
  control.configs.length = 0
  control.configErrorFor = undefined
  control.configErrorValue = undefined
  control.applyGate = undefined
  control.disposeGate = undefined
  await Promise.all(bridges.splice(0).map(bridge => bridge.dispose()))
  await settingsOwner?.dispose()
  settingsOwner = undefined
})

async function providerContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemorySettings)
  settingsOwner = ctx.plugin({
    name: bridgeModule.name,
    inject: bridgeModule.inject,
    Config: bridgeModule.Config,
    apply: bridgeModule.apply,
  }, { role: 'provider', servers: [] })
  await settingsOwner
  return ctx
}

function mountBridge(ctx: Context): Fiber & PromiseLike<Fiber> {
  const bridge = ctx.plugin({
    name: bridgeModule.name,
    inject: bridgeModule.inject,
    Config: bridgeModule.Config,
    apply: bridgeModule.apply,
  }, { role: 'consumer', servers: [] })
  bridges.push(bridge)
  return bridge
}

async function replaceSettings(ctx: Context, servers: UserMcpServerConfig[]): Promise<void> {
  await (ctx.get('settings') as MemorySettings).replace(bridgeModule.MCP_SETTINGS_NAMESPACE, { servers })
}

describe('mcp-user-config captured-generation lifecycle', () => {
  it('maps a streamable-http entry to the exact client contract', async () => {
    const ctx = await providerContext()
    const httpEntry = server('http1', {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: 'Bearer token' },
    })
    delete httpEntry.command
    await replaceSettings(ctx, [httpEntry])
    const bridge = mountBridge(ctx)
    await bridge

    expect(control.configs).toHaveLength(1)
    const mapped = control.configs[0]!
    expect(mapped).toMatchObject({
      transport: 'streamable-http',
      serverName: 'http1',
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: 'Bearer token' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    })
    expect(String(mapped.reservationKey)).toContain('mcp-user-config')
    expect(mapped).not.toHaveProperty('command')
    expect(mapped).not.toHaveProperty('args')
    expect(mapped).not.toHaveProperty('env')
    expect(mapped).not.toHaveProperty('cwd')
  })

  it('contains a child startup failure without leaking transport configuration', async () => {
    const ctx = await providerContext()
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    control.configErrorFor = 'boom'
    control.configErrorValue = 'broken child'
    await replaceSettings(ctx, [server('boom')])
    const bridge = mountBridge(ctx)
    await bridge

    expect(errors.join('\n')).toContain('startup failed for id "boom" and serverName "boom" (string)')
    expect(control.configs).toHaveLength(0)
    expect(errors.filter(message => message.startsWith('mcp-user-config:'))).toHaveLength(1)
  })

  it('waits for child disposal before completing generation teardown', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('only')])
    const bridge = mountBridge(ctx)
    await bridge
    expect(control.configs).toHaveLength(1)
    const disposeGate = Promise.withResolvers<undefined>()
    control.disposeGate = disposeGate.promise

    let disposed = false
    const disposing = bridge.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    disposeGate.resolve(undefined)
    await disposing

    expect(control.configs).toHaveLength(1)
  })

  it('pins the captured child set while settings change and after disposal', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('held')])
    const bridge = mountBridge(ctx)
    await bridge
    expect(control.configs).toHaveLength(1)

    await replaceSettings(ctx, [server('late')])
    expect(control.configs).toHaveLength(1)
    expect(control.configs[0]?.serverName).toBe('held')

    const disposing = bridge.dispose()
    await disposing

    expect(control.configs).toHaveLength(1)
  })

  it('keeps an existing capture while a new consumer loads replacement settings', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('keeper')])
    const existing = mountBridge(ctx)
    await existing
    expect(control.configs).toHaveLength(1)

    await replaceSettings(ctx, [server('a'), server('b')])
    expect(control.configs).toHaveLength(1)

    const next = mountBridge(ctx)
    await next
    expect(control.configs.map(config => config.serverName)).toEqual(['keeper', 'a', 'b'])
  })

  it('classifies a non-Error startup failure for a captured generation', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    settingsOwner = ctx.plugin({
      name: bridgeModule.name,
      inject: bridgeModule.inject,
      Config: bridgeModule.Config,
      apply: bridgeModule.apply,
    }, { role: 'provider', servers: [] })
    await settingsOwner
    control.configErrorFor = 'broken'
    control.configErrorValue = 'broken snapshot'
    await replaceSettings(ctx, [server('broken')])
    const bridge = mountBridge(ctx)
    await bridge

    expect(errors.join('\n')).toContain('startup failed for id "broken" and serverName "broken" (string)')
    expect(control.configs).toHaveLength(0)
  })

  it('rejects consumer rows carrying servers', async () => {
    const ctx = await providerContext()
    await expect(ctx.plugin({
      name: bridgeModule.name,
      inject: bridgeModule.inject,
      Config: bridgeModule.Config,
      apply: bridgeModule.apply,
    }, { role: 'consumer', servers: [server('stray')] })).rejects.toThrow(
      'servers are only valid for the provider role',
    )
  })

  it('resolves a consumer row without the settings service', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    const fiber = ctx.plugin({
      name: bridgeModule.name,
      inject: bridgeModule.inject,
      Config: bridgeModule.Config,
      apply: bridgeModule.apply,
    }, { role: 'consumer', servers: [] })
    await expect(fiber).resolves.toBeDefined()
    await fiber.dispose()
    expect(control.configs).toHaveLength(0)
  })
})
