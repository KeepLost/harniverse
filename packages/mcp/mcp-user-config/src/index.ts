/**
 * User-owned MCP server configuration: the exported provider registers the
 * `mcp` settings namespace once and mounts one shared-connection owner per
 * enabled server in the host/base scope, while this consumer mounts one
 * scoped registrar per selected server entry in its own profile scope — so
 * every composition projects one process-global connection per server.
 * @module @deepseek-ai/dsh-mcp-user-config
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-capabilities'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import {
  MCP_CONNECTIONS_SERVICE,
  McpConnectionsRegistry,
  McpOwnerPlugin,
  McpRegistrarPlugin,
  mcpServerCapabilityId,
} from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig, ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { McpManagementService } from './management.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-user-config'
/** Settings namespace containing the user's MCP server list. */
export const MCP_SETTINGS_NAMESPACE = settingsNamespace('mcp')
/** Host-owned Cordis service carrying the shared settings scope. */
export const MCP_USER_CONFIG_SETTINGS_SERVICE = 'mcpUserConfigSettings'
/** Host services available to both provider and profile consumer rows. */
export const inject = ['settings', 'tools']

/** Stable namespace constraints inherited from `mcp-client`. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Reconnection settings repeated here so they remain visible in the settings descriptor. */
const Reconnect = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(500),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(10),
})

/** One user-configured MCP server after schema defaults are applied. */
export interface UserMcpServerConfig {
  /** Stable identity within a captured settings generation. */
  id: string
  /** Disabled entries do not create a child plugin or expose tools. */
  enabled: boolean
  /** MCP transport selected for this entry. */
  transport: 'stdio' | 'streamable-http'
  /** Stable namespace used in model-facing tool names. */
  serverName: string
  /** Stdio executable. */
  command?: string
  /** Stdio arguments. */
  args: string[]
  /** Stdio environment additions; values are secret settings fields. */
  env: Record<string, string>
  /** Stdio working directory. */
  cwd: string
  /** Streamable HTTP endpoint. */
  url?: string
  /** Streamable HTTP headers; values are secret settings fields. */
  headers: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Attributed instruction budget; omission uses the client's 32 KiB default. */
  maxInstructionBytes?: number
  /** Whether this child rejects activation after its initial connection fails. */
  failOnStartupError: boolean
  /** Child reconnect policy. */
  reconnect: ReconnectConfig
}

/** Composition defaults for the host-owned `mcp` settings namespace. */
export interface McpUserConfigSettingsConfig {
  servers: UserMcpServerConfig[]
}

/** Loader role for one named plugin row. */
export type McpUserConfigRole = 'provider' | 'consumer'

/** Settings schema for one server, kept flat so secret roles are redaction-reachable. */
const UserMcpServer = z.object({
  id: z.string().required().pattern(SERVER_ID_PATTERN),
  enabled: z.boolean().default(true),
  transport: z.union(['stdio', 'streamable-http']).required(),
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  command: z.string(),
  args: z.array(String).default([]),
  env: z.dict(z.string().role('secret')).default({}),
  cwd: z.string().default(''),
  url: z.string(),
  headers: z.dict(z.string().role('secret')).default({}),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  maxInstructionBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  failOnStartupError: z.boolean().default(false),
  reconnect: Reconnect,
})

/** Schema for the host-owned `mcp` settings section and provider composition. */
export const SettingsConfig: z<McpUserConfigSettingsConfig> = z.object({
  servers: z.array(UserMcpServer).default([]),
})

/** Single Loader config schema; provider rows carry the base settings layer. */
export interface Config {
  /** Select the host settings owner or a profile-scoped consumer. */
  role: McpUserConfigRole
  /** Composition defaults used by provider rows; consumer rows must leave this empty. */
  servers: UserMcpServerConfig[]
}
/** Consumer is the safe default for profile-scoped rows. */
export const Config: z<Config> = z.object({
  role: z.union(['provider', 'consumer']).default('consumer'),
  servers: z.array(UserMcpServer).default([]),
})

/** Read/watch-only view of the host-owned `mcp` settings scope. */
export interface McpUserConfigSettingsService {
  /**
   * Read the private snapshot for a captured generation, or current settings.
   * @param scope - standing generation key; standalone consumers may omit it.
   * @returns an independent copy of the validated server list.
   */
  get(scope?: ScopeKey): McpUserConfigSettingsConfig
  /**
   * Subscribe to validated settings replacements and return the disposer.
   * @param callback - invoked after each committed settings replacement.
   * @returns the disposer that removes the subscription.
   */
  watch(callback: (next: McpUserConfigSettingsConfig, prev: McpUserConfigSettingsConfig) => void | Promise<void>): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpUserConfigSettings: McpUserConfigSettingsService
  }
}

const CONFIG_KEYS = new Set(['servers'])
const SERVER_KEYS = new Set([
  'id', 'enabled', 'transport', 'serverName', 'command', 'args', 'env', 'cwd', 'url', 'headers',
  'toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnect',
])
const RECONNECT_KEYS = new Set(['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'])

/** One mounted child (owner or registrar) retained until its setting leaves. */
interface ChildRecord {
  config: UserMcpServerConfig
  fiber: Fiber & PromiseLike<Fiber>
}

let consumerReservationCounter = 0
let settingsGenerationCounter = 0

/** Mint one reservation owner key for this consumer's scoped registry. */
function reservationKeyFor(): string {
  return `mcp-user-config-${++consumerReservationCounter}`
}

function assertKnownKeys(value: object, keys: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`mcp-user-config: unknown key "${path}.${key}"`)
  }
}

/** Map a validated user entry to the shared-connection owner config. */
function toOwnerConfig(entry: UserMcpServerConfig): McpClientConfig & { serverId: string } {
  const common = {
    serverId: entry.id,
    serverName: entry.serverName,
    toolCallTimeoutMs: entry.toolCallTimeoutMs,
    ...entry.maxInstructionBytes === undefined ? {} : { maxInstructionBytes: entry.maxInstructionBytes },
    failOnStartupError: entry.failOnStartupError,
    reconnect: entry.reconnect,
  }
  if (entry.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: entry.command as string,
      args: [...entry.args],
      env: { ...entry.env },
      cwd: entry.cwd,
    }
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: entry.url as string,
    headers: { ...entry.headers },
  }
}

/** Stable per-owner configuration identity: any change remounts the owner. */
function ownerConfigSignature(entry: UserMcpServerConfig): string {
  return JSON.stringify(toOwnerConfig(entry))
}

/**
 * Validate cross-entry identity and transport constraints before any child is mounted.
 * Invalid settings fail closed and leave the last good child set untouched.
 */
function validateSettingsConfig(value: McpUserConfigSettingsConfig): void {
  assertKnownKeys(value, CONFIG_KEYS, 'mcp')
  const ids = new Set<string>()
  const serverNames = new Set<string>()
  for (const [index, entry] of value.servers.entries()) {
    const path = `mcp.servers[${String(index)}]`
    assertKnownKeys(entry, SERVER_KEYS, path)
    if (ids.has(entry.id)) throw new TypeError(`mcp-user-config: duplicate stable id "${entry.id}"`)
    ids.add(entry.id)
    if (serverNames.has(entry.serverName)) {
      throw new TypeError(`mcp-user-config: duplicate serverName "${entry.serverName}"`)
    }
    serverNames.add(entry.serverName)

    if (entry.transport === 'stdio') {
      if (entry.command === undefined) throw new TypeError(`mcp-user-config: ${path}.command is required for stdio`)
      if (entry.url !== undefined) throw new TypeError(`mcp-user-config: ${path}.url is only valid for streamable-http`)
    } else {
      if (entry.url === undefined) throw new TypeError(`mcp-user-config: ${path}.url is required for streamable-http`)
      if (entry.command !== undefined) throw new TypeError(`mcp-user-config: ${path}.command is only valid for stdio`)
    }

    assertKnownKeys(entry.reconnect, RECONNECT_KEYS, `${path}.reconnect`)
    const { initialDelayMs, maxDelayMs } = entry.reconnect
    if (initialDelayMs !== undefined && maxDelayMs !== undefined && initialDelayMs > maxDelayMs) {
      throw new TypeError(`mcp-user-config: ${path}.reconnect.initialDelayMs must be less than or equal to maxDelayMs`)
    }
  }
}

/** Mount once in the host/base scope to own the single `mcp` registration.
 * @param ctx - Host plugin context providing the Settings service.
 * @param config - Provider role configuration and its composition defaults.
 */
export function applySettingsProvider(ctx: Context, config: Config): void {
  const resolvedConfig = SettingsConfig({ servers: config.servers })
  validateSettingsConfig(resolvedConfig)
  const scope = ctx.settings.register(MCP_SETTINGS_NAMESPACE, SettingsConfig, {
    base: resolvedConfig,
    validate: validateSettingsConfig,
  })
  const captured = new WeakMap<ScopeKey, McpUserConfigSettingsConfig>()
  let revision = ++settingsGenerationCounter
  ctx.effect(() => scope.watch(() => { revision = ++settingsGenerationCounter }), 'mcp-user-config.revision')
  applyOwnerFleet(ctx, scope)
  ctx.provide(MCP_USER_CONFIG_SETTINGS_SERVICE, {
    get: key => structuredClone(key === undefined ? scope.get() : captured.get(key) ?? scope.get()),
    watch: callback => scope.watch(callback),
  })
  ctx.inject(['capabilities'], (inner) => {
    inner.capabilities.registerAdapter((control) => {
      inner.effect(() => scope.watch(() => { control.invalidate() }), 'mcp-user-config.catalog')
      return {
        id: 'mcp-user-config',
        snapshot: view => ({
          complete: true,
          // Scoped clients own their discovered members; unmounted Profiles only need identities.
          entries: view.scope !== undefined || view.scopes?.length ? [] : scope.get().servers.filter(entry => entry.enabled).map(entry => ({
            id: mcpServerCapabilityId(entry.serverName),
            kind: 'mcp-server' as const,
            name: entry.serverName,
            description: `MCP server ${entry.serverName}`,
            provenance: 'external' as const,
            assembleable: true,
            available: true,
            defaultLoaded: true,
            manageable: true,
            owner: '@deepseek-ai/dsh-mcp-client',
            requires: [],
          })),
        }),
        capture: () => {
          const value = structuredClone(scope.get())
          return {
            signature: String(revision),
            mount: (generationCtx, entries) => {
              const key = scopeOf(generationCtx)
              if (key === undefined) throw new Error('mcp-user-config: generation requires a scope key')
              const selected = {
                servers: value.servers.filter(server =>
                  entries.find(entry => entry.id === mcpServerCapabilityId(server.serverName))?.selected !== false),
              }
              generationCtx.effect(() => {
                captured.set(key, selected)
                return () => { captured.delete(key) }
              }, 'mcp-user-config.capture')
            },
          }
        },
      }
    })
  })
}

/** Log a child failure without copying transport configuration into the log. */
function logChildFailure(ctx: Context, entry: UserMcpServerConfig, operation: string, error: unknown): void {
  /* v8 ignore next -- cordis normalizes fiber rejections to Error instances; the fallback
     keeps the log total for direct programmatic callers. */
  const kind = error instanceof Error ? error.name : typeof error
  ctx.logger.error(
    `mcp-user-config: ${operation} failed for id "${entry.id}" and serverName "${entry.serverName}" (${kind})`,
  )
}

/** The `mcp` settings scope face the fleet reads. */
interface SettingsScopeFace {
  get(): McpUserConfigSettingsConfig
  watch(callback: () => void | Promise<void>): () => void
}

/**
 * Own the process-global connection fleet for the current settings: one
 * shared-connection owner child per enabled entry, remounted whenever its
 * configuration changes, plus the management Remote over the fleet.
 * @param ctx - host/base plugin context carrying the settings scope.
 * @param scope - the registered `mcp` settings scope.
 */
function applyOwnerFleet(ctx: Context, scope: SettingsScopeFace): void {
  const registry = new McpConnectionsRegistry()
  ctx.provide(MCP_CONNECTIONS_SERVICE, registry)
  const owners = new Map<string, ChildRecord>()
  /** Serializes fleet mutations so a restart cannot race a settings-driven remount. */
  let fleetChain: Promise<void> = Promise.resolve()

  const mountOwner = (entry: UserMcpServerConfig): void => {
    const fiber = ctx.plugin(McpOwnerPlugin, toOwnerConfig(entry))
    owners.set(entry.id, { config: entry, fiber })
    // Owner startup is contained by design; the rejection log keeps the id visible.
    void Promise.resolve(fiber).catch((error: unknown) => { logChildFailure(ctx, entry, 'owner startup', error) })
  }

  const disposeOwner = async (record: ChildRecord): Promise<void> => {
    owners.delete(record.config.id)
    /* v8 ignore next 3 -- cordis contains effect-disposer failures inside fiber.dispose; the fleet continues either way. */
    try {
      await record.fiber.dispose()
    } catch (error) {
      logChildFailure(ctx, record.config, 'owner disposal', error)
    }
  }

  const runOnFleet = (step: () => Promise<void>): Promise<void> => {
    const next = fleetChain.then(step, step)
    fleetChain = next.catch(() => {})
    return next
  }

  /** Reconcile the fleet with the current settings snapshot. */
  const syncFleet = (): void => {
    void runOnFleet(async () => {
      const enabled = scope.get().servers.filter(entry => entry.enabled)
      for (const [id, record] of [...owners]) {
        const next = enabled.find(entry => entry.id === id)
        if (next !== undefined && ownerConfigSignature(next) === ownerConfigSignature(record.config)) continue
        await disposeOwner(record)
      }
      for (const entry of enabled) {
        if (owners.has(entry.id)) continue
        mountOwner(entry)
      }
    })
  }

  /**
   * Dispose and remount one server's owner with unchanged configuration.
   * @param serverId - stable settings identity of the enabled server.
   * @returns settlement after the old owner disposed and its replacement mounted.
   */
  const restartOwner = (serverId: string): Promise<void> => runOnFleet(async () => {
    const entry = scope.get().servers.find(candidate => candidate.id === serverId)
    if (entry === undefined) throw new Error(`mcp-user-config: unknown server "${serverId}"`)
    if (!entry.enabled) throw new Error(`mcp-user-config: server "${serverId}" is disabled`)
    const record = owners.get(serverId)
    /* v8 ignore start -- a settings race can find no live owner yet; restart then just mounts a fresh one. */
    if (record !== undefined) {
      await disposeOwner(record)
    } else {
      mountOwner(entry)
      return
    }
    /* v8 ignore stop */
    mountOwner(entry)
  })

  ctx.effect(() => {
    const unsubscribe = scope.watch(() => { syncFleet() })
    syncFleet()
    return () => {
      unsubscribe()
      void runOnFleet(async () => {
        await Promise.all([...owners.values()].map(record => disposeOwner(record)))
      })
    }
  }, 'mcp-user-config.fleet')

  // The management Remote registers itself on this context and leaves with
  // the provider fiber; no manual teardown exists or is needed.
  void new McpManagementService(ctx, {
    registry,
    entries: () => scope.get().servers,
    restartOwner,
  })
}

/** Mount only the settings captured by this Profile generation. */
async function applyConsumer(ctx: Context, settings: McpUserConfigSettingsService): Promise<void> {
  const children = new Map<string, ChildRecord>()
  const snapshot = settings.get(scopeOf(ctx))
  validateSettingsConfig(snapshot)
  const reservationKey = reservationKeyFor()
  const lifecycle = ctx.effect(async () => {
    // Async boundary on purpose: cordis routes a child fiber's rejection
    // through the effect's promise, where the containment below attaches;
    // a synchronous callback lets the same rejection surface as a
    // context-level error before the catch runs.
    await Promise.resolve()
    for (const entry of snapshot.servers.filter(entry => entry.enabled)) {
      // A registrar never rejects on connection state; a rejection here means
      // a duplicate namespace, which the loader surfaces for the composition.
      // Both the synchronous mount throw and the fiber rejection are
      // contained the same way, so one broken entry never fails the consumer.
      try {
        const fiber = ctx.plugin(McpRegistrarPlugin, {
          serverId: entry.id,
          serverName: entry.serverName,
          reservationKey,
        })
        children.set(entry.id, { config: entry, fiber })
        void Promise.resolve(fiber).catch((error: unknown) => { logChildFailure(ctx, entry, 'registrar startup', error) })
      } catch (error) {
        /* v8 ignore next -- sync throws require a malformed plugin shape; the registrar import always carries apply. */
        logChildFailure(ctx, entry, 'registrar startup', error)
      }
    }
    return async () => {
      await Promise.all([...children.values()].map(async (record) => {
        children.delete(record.config.id)
        /* v8 ignore next 3 -- cordis contains effect-disposer failures inside fiber.dispose; the generation unwinds either way. */
        try {
          await record.fiber.dispose()
        } catch (error) {
          logChildFailure(ctx, record.config, 'registrar disposal', error)
        }
      }))
    }
  }, 'mcp-user-config.lifecycle')
  await lifecycle
}

/**
 * Run the provider or consumer role selected by the one Loader plugin row.
 * @param ctx - plugin context carrying the host services and profile tools.
 * @param config - provider/consumer role and provider base settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolvedConfig = Config(config)
  if (resolvedConfig.role === 'provider') {
    applySettingsProvider(ctx, resolvedConfig)
    return
  }
  if (resolvedConfig.servers.length > 0) {
    throw new TypeError('mcp-user-config: servers are only valid for the provider role')
  }
  const settings = ctx.get(MCP_USER_CONFIG_SETTINGS_SERVICE)
  if (settings === undefined) return
  await applyConsumer(ctx, settings)
}
