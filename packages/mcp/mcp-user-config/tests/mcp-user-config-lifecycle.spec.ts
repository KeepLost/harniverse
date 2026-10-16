/**
 * Captured-generation lifecycle against a scripted mcp-client: streamable HTTP
 * mapping, startup failure containment, generation pinning, and quiescent
 * disposal.
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import Capabilities from '@deepseek-ai/dsh-capabilities'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserMcpServerConfig } from '../src/index.ts'
import * as bridgeModule from '../src/index.ts'

const control = vi.hoisted(() => ({
  ownerConfigs: [] as Array<Record<string, unknown>>,
  registrarConfigs: [] as Array<Record<string, unknown>>,
  ownerErrorFor: undefined as string | undefined,
  ownerErrorValue: undefined as unknown,
  registrarErrorFor: undefined as string | undefined,
  registrarErrorValue: undefined as unknown,
  ownerDisposeErrorFor: undefined as string | undefined,
  applyGate: undefined as Promise<undefined> | undefined,
  disposeGate: undefined as Promise<undefined> | undefined,
}))

vi.mock('@deepseek-ai/dsh-mcp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client')>()
  const ownerApply = async (ctx: Context, config: unknown): Promise<void> => {
    const entry = config as { serverName?: string }
    if (entry.serverName === control.ownerErrorFor) {
      control.ownerErrorFor = undefined
      throw control.ownerErrorValue
    }
    control.ownerConfigs.push(config as Record<string, unknown>)
    ctx.effect(async () => {
      if (control.applyGate !== undefined) await control.applyGate
      return async () => {
        if (control.ownerDisposeErrorFor === entry.serverName) throw new Error('owner teardown bug')
        if (control.disposeGate !== undefined) await control.disposeGate
      }
    })
  }
  const registrarApply = async (ctx: Context, config: unknown): Promise<void> => {
    const entry = config as { serverName?: string }
    if (entry.serverName === control.registrarErrorFor) {
      control.registrarErrorFor = undefined
      throw control.registrarErrorValue
    }
    control.registrarConfigs.push(config as Record<string, unknown>)
    ctx.effect(async () => {
      if (control.applyGate !== undefined) await control.applyGate
      return async () => {
        if (control.disposeGate !== undefined) await control.disposeGate
      }
    })
  }
  return {
    ...actual,
    McpOwnerPlugin: { ...actual.McpOwnerPlugin, apply: ownerApply },
    McpRegistrarPlugin: { ...actual.McpRegistrarPlugin, apply: registrarApply },
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
  control.ownerConfigs.length = 0
  control.registrarConfigs.length = 0
  control.ownerErrorFor = undefined
  control.ownerErrorValue = undefined
  control.registrarErrorFor = undefined
  control.registrarErrorValue = undefined
  control.ownerDisposeErrorFor = undefined
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
  it('forwards an explicit instruction budget to the shared owner transport', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('bounded', { maxInstructionBytes: 128 })])
    await mountBridge(ctx)
    expect(control.ownerConfigs).toHaveLength(1)
    expect(control.ownerConfigs[0]).toMatchObject({ serverId: 'bounded', serverName: 'bounded', maxInstructionBytes: 128 })
    expect(control.registrarConfigs).toEqual([{ serverId: 'bounded', serverName: 'bounded', reservationKey: expect.stringContaining('mcp-user-config') }])
  })

  it('watches committed settings until released and returns independent uncaptured reads', async () => {
    const ctx = await providerContext()
    const service = ctx.mcpUserConfigSettings
    const changes: string[][] = []
    const release = service.watch((next, previous) => {
      changes.push([previous.servers[0]?.id ?? 'empty', next.servers[0]!.id])
    })
    await replaceSettings(ctx, [server('first')])
    expect(changes).toEqual([['empty', 'first']])
    const key = {}
    const scope = createScope(ctx, key)
    const snapshot = service.get(key)
    snapshot.servers.length = 0
    expect(service.get(key).servers.map(entry => entry.id)).toEqual(['first'])
    release()
    await replaceSettings(ctx, [server('second')])
    expect(changes).toEqual([['empty', 'first']])
    expect(service.get(key).servers.map(entry => entry.id)).toEqual(['second'])
    await scope.dispose()
  })

  it('refuses to mount a captured settings generation without a scope key', async () => {
    const ctx = await providerContext()
    await ctx.plugin(Capabilities)
    await replaceSettings(ctx, [server('captured')])
    const capture = ctx.capabilities.captureGeneration({})
    expect(() => { capture.mount(ctx, []) }).toThrow('generation requires a scope key')
    expect(ctx.mcpUserConfigSettings.get().servers.map(entry => entry.id)).toEqual(['captured'])
    // The global owner fleet is settings-driven and mounts regardless; the
    // refusal is about the composition's scoped registrars.
    expect(control.registrarConfigs).toEqual([])
  })

  it('maps a streamable-http entry to the exact owner contract', async () => {
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

    expect(control.ownerConfigs).toHaveLength(1)
    const mapped = control.ownerConfigs[0]!
    expect(mapped).toMatchObject({
      serverId: 'http1',
      transport: 'streamable-http',
      serverName: 'http1',
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: 'Bearer token' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    })
    expect(mapped).not.toHaveProperty('reservationKey')
    expect(mapped).not.toHaveProperty('command')
    expect(mapped).not.toHaveProperty('args')
    expect(mapped).not.toHaveProperty('env')
    expect(mapped).not.toHaveProperty('cwd')
    expect(control.registrarConfigs).toHaveLength(1)
    expect(control.registrarConfigs[0]).toMatchObject({ serverId: 'http1', serverName: 'http1' })
    expect(String(control.registrarConfigs[0]!.reservationKey)).toContain('mcp-user-config')
  })

  it('keeps an unchanged owner while mounting an added sibling', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('alpha')])
    await vi.waitFor(() => { expect(control.ownerConfigs.map(config => config.serverName)).toEqual(['alpha']) })
    // alpha's configuration is unchanged: its owner is kept, not remounted.
    await replaceSettings(ctx, [server('alpha'), server('beta')])
    await vi.waitFor(() => { expect(control.ownerConfigs.map(config => config.serverName)).toEqual(['alpha', 'beta']) })
  })

  it('continues the fleet chain after a rejected restart', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('alpha')])
    await vi.waitFor(() => { expect(control.ownerConfigs).toHaveLength(1) })
    const management = ctx.get('mcpManagement')
    await expect(management!.restart('ghost')).rejects.toThrow('mcp-user-config: unknown server "ghost"')
    // The rejected step must not wedge the serialized fleet mutations.
    await replaceSettings(ctx, [server('alpha', { enabled: false })])
    await vi.waitFor(() => { expect(ctx.mcpConnections.get('alpha')).toBeUndefined() })
  })

  it('contains an owner startup rejection without leaking transport configuration', async () => {
    const ctx = await providerContext()
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    control.ownerErrorFor = 'boom'
    control.ownerErrorValue = new TypeError('broken child')
    await replaceSettings(ctx, [server('boom')])
    const bridge = mountBridge(ctx)
    await bridge

    expect(errors.join('\n')).toContain('owner startup failed for id "boom" and serverName "boom" (TypeError)')
    expect(control.ownerConfigs).toHaveLength(0)
    expect(errors.filter(message => message.startsWith('mcp-user-config:'))).toHaveLength(1)
  })

  it('waits for child disposal before completing generation teardown', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('only')])
    const bridge = mountBridge(ctx)
    await bridge
    expect(control.registrarConfigs).toHaveLength(1)
    const disposeGate = Promise.withResolvers<undefined>()
    control.disposeGate = disposeGate.promise

    let disposed = false
    const disposing = bridge.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    disposeGate.resolve(undefined)
    await disposing

    expect(control.registrarConfigs).toHaveLength(1)
  })

  it('pins the captured registrar set while the global fleet follows settings', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('held')])
    const bridge = mountBridge(ctx)
    await bridge
    expect(control.registrarConfigs).toHaveLength(1)

    await replaceSettings(ctx, [server('late')])
    // The pinned composition keeps its captured registrar; the fleet remounts.
    expect(control.registrarConfigs).toHaveLength(1)
    expect(control.registrarConfigs[0]?.serverName).toBe('held')
    // The fleet disposed the held owner and mounted the late one.
    await vi.waitFor(() => { expect(control.ownerConfigs.map(config => config.serverName)).toEqual(['held', 'late']) })

    const disposing = bridge.dispose()
    await disposing

    expect(control.registrarConfigs).toHaveLength(1)
  })

  it('keeps an existing capture while a new consumer loads replacement settings', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('keeper')])
    const existing = mountBridge(ctx)
    await existing
    expect(control.registrarConfigs).toHaveLength(1)

    await replaceSettings(ctx, [server('a'), server('b')])
    expect(control.registrarConfigs).toHaveLength(1)

    const next = mountBridge(ctx)
    await next
    expect(control.registrarConfigs.map(config => config.serverName)).toEqual(['keeper', 'a', 'b'])
  })

  it('classifies a typed registrar startup rejection for a captured generation', async () => {
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
    control.registrarErrorFor = 'broken'
    control.registrarErrorValue = new TypeError('broken snapshot')
    await replaceSettings(ctx, [server('broken')])
    const bridge = mountBridge(ctx)
    await bridge

    expect(errors.join('\n')).toContain('registrar startup failed for id "broken" and serverName "broken" (TypeError)')
    expect(control.registrarConfigs).toHaveLength(0)
  })

  it('reconciles the fleet across settings changes', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('alpha')])
    await vi.waitFor(() => { expect(control.ownerConfigs.map(config => config.serverName)).toEqual(['alpha']) })

    // A configuration change remounts the owner; the stable id stays.
    await replaceSettings(ctx, [server('alpha', { toolCallTimeoutMs: 5_000 })])
    await vi.waitFor(() => { expect(control.ownerConfigs.map(config => config.serverName)).toEqual(['alpha', 'alpha']) })
    expect(control.ownerConfigs[1]).toMatchObject({ toolCallTimeoutMs: 5_000 })

    // Disabling the row disposes the owner without a replacement.
    await replaceSettings(ctx, [server('alpha', { enabled: false })])
    await vi.waitFor(() => { expect(ctx.mcpConnections.get('alpha')).toBeUndefined() })
    expect(control.ownerConfigs).toHaveLength(2)
  })

  it('reports status rows and restarts one server through the management service', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('alpha'), server('beta', { enabled: false })])
    await vi.waitFor(() => { expect(control.ownerConfigs).toHaveLength(1) })

    const management = ctx.get('mcpManagement')
    expect(management).toBeDefined()
    // The mocked owner registers no live handle, so the enabled row reads stopped.
    type Row = { id: string; state: string; tools: unknown[] }
    expect(management!.status().map((row: Row) => ({ id: row.id, state: row.state, tools: row.tools })))
      .toEqual([
        { id: 'alpha', state: 'stopped', tools: [] },
        { id: 'beta', state: 'disabled', tools: [] },
      ])

    await management!.restart('alpha')
    await vi.waitFor(() => { expect(control.ownerConfigs.map(config => config.serverName)).toEqual(['alpha', 'alpha']) })
    await expect(management!.restart('beta')).rejects.toThrow('server "beta" is disabled')
    await expect(management!.restart('ghost')).rejects.toThrow('mcp-user-config: unknown server "ghost"')
  })

  it('continues the fleet past a failing owner teardown', async () => {
    const ctx = await providerContext()
    await replaceSettings(ctx, [server('alpha')])
    await vi.waitFor(() => { expect(control.ownerConfigs).toHaveLength(1) })
    // The disposer rejection stays inside cordis's fiber teardown; the fleet
    // chain must still mount the replacement owner.
    control.ownerDisposeErrorFor = 'alpha'
    await replaceSettings(ctx, [server('beta')])
    await vi.waitFor(() => { expect(control.ownerConfigs.map(config => config.serverName)).toEqual(['alpha', 'beta']) })
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
    expect(control.registrarConfigs).toHaveLength(0)
  })
})
