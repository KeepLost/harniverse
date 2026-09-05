/**
 * Focused lifecycle tests for the user-owned MCP settings bridge.
 * The Cordis child fibers, settings provider, and local MCP fixture process
 * are real.
 */
import { fileURLToPath } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserMcpServerConfig } from '../src/index.ts'

import * as bridgeModule from '../src/index.ts'

const fixtureServerPath = fileURLToPath(new URL('../../mcp-client/tests/fixture-server.ts', import.meta.url))
const fixturePackageDir = fileURLToPath(new URL('../../mcp-client/', import.meta.url))

class MemorySettings extends SettingsProvider {
  override readonly writable = true
  private rawDocument: Record<string, unknown>

  constructor(ctx: Context, config: { doc?: Record<string, unknown> } = {}) {
    super(ctx)
    this.rawDocument = config.doc ?? {}
  }

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
    args: [fixtureServerPath],
    env: {},
    cwd: fixturePackageDir,
    headers: {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    ...overrides,
  }
}

type BridgeFiber = Fiber & PromiseLike<Fiber>

describe('mcp-user-config plugin', () => {
  let ctx: Context
  let settingsOwner: BridgeFiber | undefined
  const bridges: BridgeFiber[] = []
  const profileServices: BridgeFiber[] = []

  beforeEach(async () => {
    ctx = new Context()
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
  })

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map(bridge => bridge.dispose()))
    await Promise.all(profileServices.splice(0).map(service => service.dispose()))
    await settingsOwner?.dispose()
    settingsOwner = undefined
  })

  async function mount(servers: UserMcpServerConfig[]): Promise<void> {
    await (ctx.get('settings') as MemorySettings).replace(bridgeModule.MCP_SETTINGS_NAMESPACE, { servers })
    const bridge = ctx.plugin({
      name: bridgeModule.name,
      inject: bridgeModule.inject,
      Config: bridgeModule.Config,
      apply: bridgeModule.apply,
    }, { role: 'consumer', servers: [] })
    bridges.push(bridge)
    await bridge
  }

  async function mountProfile(): Promise<Context> {
    const profile = ctx.isolate('tools')
    const tools = profile.plugin(ToolRuntime)
    profileServices.push(tools)
    await tools
    const bridge = profile.plugin({
      name: bridgeModule.name,
      inject: bridgeModule.inject,
      Config: bridgeModule.Config,
      apply: bridgeModule.apply,
    }, { role: 'consumer', servers: [] })
    bridges.push(bridge)
    await bridge
    return profile
  }

  it('exports the named plugin contract and materializes settings defaults', () => {
    expect(bridgeModule.name).toBe('mcp-user-config')
    expect(bridgeModule.inject).toEqual(['settings', 'tools'])
    expect(bridgeModule.Config({} as never)).toEqual({ role: 'consumer', servers: [] })
    expect(bridgeModule.SettingsConfig({} as never)).toEqual({ servers: [] })

    const resolved = bridgeModule.SettingsConfig({
      servers: [{ id: 'alpha', transport: 'stdio', serverName: 'alpha', command: 'fixture-server' }],
    } as never)
    expect(resolved.servers[0]).toMatchObject({
      id: 'alpha',
      enabled: true,
      args: [],
      env: {},
      cwd: '',
      headers: {},
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    })
  })

  it('rejects a second provider role without replacing the shared namespace', async () => {
    const second = ctx.plugin({
      name: bridgeModule.name,
      inject: bridgeModule.inject,
      Config: bridgeModule.Config,
      apply: bridgeModule.apply,
    }, { role: 'provider', servers: [] })

    await expect(second).rejects.toThrow('settings namespace "mcp" is already registered')
    expect(ctx.settings.describe().filter(entry => entry.ns === bridgeModule.MCP_SETTINGS_NAMESPACE)).toHaveLength(1)
  })

  it('does not load or disclose a disabled entry', async () => {
    await mount([server('enabled'), server('disabled', { enabled: false })])

    expect(ctx.tools.get('mcp__enabled__add')).toBeDefined()
    expect(ctx.tools.get('mcp__disabled__add')).toBeUndefined()
  })

  it('mounts multiple child clients and disposes every child', async () => {
    await mount([server('one'), server('two')])

    expect(ctx.tools.get('mcp__one__add')).toBeDefined()
    expect(ctx.tools.get('mcp__two__add')).toBeDefined()

    const bridge = bridges[0]
    if (bridge === undefined) throw new Error('test bridge was not mounted')
    await bridge.dispose()
    expect(ctx.tools.get('mcp__one__add')).toBeUndefined()
    expect(ctx.tools.get('mcp__two__add')).toBeUndefined()
  })

  it('shares one settings owner without globalizing profile consumers', async () => {
    const first = await mountProfile()
    const second = await mountProfile()

    expect(ctx.tools.get('mcp__shared__add')).toBeUndefined()
    expect(first.tools.get('mcp__shared__add')).toBeUndefined()
    expect(second.tools.get('mcp__shared__add')).toBeUndefined()
    expect(ctx.settings.describe().some(entry => entry.ns === bridgeModule.MCP_SETTINGS_NAMESPACE)).toBe(true)

    const firstBridge = bridges[0]
    if (firstBridge === undefined) throw new Error('first profile bridge was not mounted')
    await firstBridge.dispose()
    expect(first.tools.get('mcp__shared__add')).toBeUndefined()
    expect(second.tools.get('mcp__shared__add')).toBeUndefined()
    expect(ctx.settings.describe().some(entry => entry.ns === bridgeModule.MCP_SETTINGS_NAMESPACE)).toBe(true)
  })

  it('contains one child startup failure while exposing an unrelated child', async () => {
    await mount([
      server('bad', { command: '/definitely/missing/mcp-server', args: [], failOnStartupError: true }),
      server('good'),
    ])

    expect(ctx.tools.get('mcp__bad__add')).toBeUndefined()
    expect(ctx.tools.get('mcp__good__add')).toBeDefined()
  })

  it('adds, removes, and restarts children from serialized settings updates', async () => {
    await mount([server('one')])
    const settings = ctx.get('settings') as MemorySettings

    await settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, { servers: [server('one'), server('two')] })
    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__two__add')).toBeDefined()
    }, { timeout: 5_000 })

    await settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, { servers: [server('two')] })
    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__one__add')).toBeUndefined()
    }, { timeout: 5_000 })

    await settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [server('two', { serverName: 'two-restarted' })],
    })
    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__two-restarted__add')).toBeDefined()
    }, { timeout: 5_000 })
    expect(ctx.tools.get('mcp__two__add')).toBeUndefined()
  })

  it('rejects duplicate stable ids before mounting any child', async () => {
    const settings = ctx.get('settings') as MemorySettings
    await expect(settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [server('duplicate'), server('duplicate', { serverName: 'other' })],
    })).rejects.toThrow('duplicate stable id "duplicate"')

    expect(ctx.tools.schemas().some(tool => tool.name.startsWith('mcp__'))).toBe(false)
  })

  it('rejects invalid transport entries instead of mounting them', async () => {
    const invalid = server('http', { transport: 'streamable-http' })
    delete invalid.command
    const settings = ctx.get('settings') as MemorySettings
    await expect(settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [invalid],
    })).rejects.toThrow('url is required for streamable-http')

    expect(ctx.tools.schemas().some(tool => tool.name.startsWith('mcp__'))).toBe(false)
  })

  it('redacts configured environment values from settings descriptors', async () => {
    await mount([server('secret', { env: { MCP_TOKEN: 'do-not-disclose' } })])

    const descriptor = ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === bridgeModule.MCP_SETTINGS_NAMESPACE)
    expect(descriptor?.value).toMatchObject({ servers: [{ env: {} }] })
    expect(descriptor?.secrets).toContainEqual({ path: ['servers', '0', 'env', 'MCP_TOKEN'], set: true })
    expect(JSON.stringify(descriptor)).not.toContain('do-not-disclose')
  })
})

describe('mcp-user-config settings validation', () => {
  let validationCtx: Context
  let ownerFiber: BridgeFiber

  beforeEach(async () => {
    validationCtx = new Context()
    await validationCtx.plugin(SystemPrompt)
    await validationCtx.plugin(ToolRuntime)
    await validationCtx.plugin(MemorySettings)
    ownerFiber = validationCtx.plugin({
      name: bridgeModule.name,
      inject: bridgeModule.inject,
      Config: bridgeModule.Config,
      apply: bridgeModule.apply,
    }, { role: 'provider', servers: [] })
    await ownerFiber
  })

  afterEach(async () => {
    await ownerFiber.dispose()
    await validationCtx.fiber.dispose()
  })

  it('rejects unknown keys at the section and server level', async () => {
    const settings = validationCtx.get('settings') as MemorySettings
    await expect(settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [],
      extra: true,
    })).rejects.toThrow('unknown key "mcp.extra"')
    await expect(settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [{ ...server('odd'), bogus: 1 }],
    })).rejects.toThrow('unknown key "mcp.servers[0].bogus"')
  })

  it('rejects duplicate serverName values', async () => {
    const settings = validationCtx.get('settings') as MemorySettings
    await expect(settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [server('first'), server('second', { serverName: 'first' })],
    })).rejects.toThrow('duplicate serverName "first"')
  })

  it('rejects a stdio entry without command', async () => {
    const invalid = server('commandless')
    delete invalid.command
    const settings = validationCtx.get('settings') as MemorySettings
    await expect(settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [invalid],
    })).rejects.toThrow('command is required for stdio')
  })

  it('rejects a stdio entry carrying a url', async () => {
    const settings = validationCtx.get('settings') as MemorySettings
    await expect(settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [server('with-url', { url: 'http://127.0.0.1:9/mcp' })],
    })).rejects.toThrow('url is only valid for streamable-http')
  })

  it('rejects an http entry carrying a command', async () => {
    const invalid = server('with-command', {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:9/mcp',
    })
    const settings = validationCtx.get('settings') as MemorySettings
    await expect(settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [invalid],
    })).rejects.toThrow('command is only valid for stdio')
  })

  it('rejects a reconnect policy whose initial delay exceeds its ceiling', async () => {
    const settings = validationCtx.get('settings') as MemorySettings
    await expect(settings.replace(bridgeModule.MCP_SETTINGS_NAMESPACE, {
      servers: [server('eager', { reconnect: { enabled: true, initialDelayMs: 40_000, maxDelayMs: 30_000, maxAttempts: 10 } })],
    })).rejects.toThrow('initialDelayMs must be less than or equal to maxDelayMs')
  })

})
