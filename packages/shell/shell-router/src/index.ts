/**
 * Routing Service Provider for the `ctx.shell` seam: mounts both sandboxed
 * shell executor families in isolated child scopes and dispatches every
 * resolve/run/start by the request's stamped `family` (defaulting to the
 * host's boot-resolved family), so one host serves sessions with different
 * shell selections without duplicate `ctx.shell` registrations.
 *
 * A family mounts only when a shell binary it can serve resolves through
 * `ctx.subprocess.resolveExecutable` in the execution world — the platform
 * builtin, or any shell-registry entry routing to that family — so
 * availability reflects the world rather than the mount. Family isolation
 * also covers the `settings` service: the executors share one `shell`
 * settings namespace that exists precisely because a host composes exactly
 * one family, so under the router both families run on their
 * composition-entry config (the seam's designed no-settings fallback) and
 * the namespace stays unregistered.
 *
 * Registry entries probe at mount alongside the builtins; the resolved
 * absolute paths publish through {@link ShellRouter.availability} for the
 * single session resolver, and unstamped requests carry the default entry's
 * materialized executable on their spec.
 * @module @deepseek-ai/dsh-shell-router
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import {
  BUILTIN_POSIX_ID,
  LEGACY_BASH_FAMILY_ID,
  PLATFORM_DEFAULT_ID,
  SHELL_BACKEND_ENV,
  builtinRegistryEntries,
  registryEntryIndex,
  resolveShellBackend,
} from '@deepseek-ai/dsh-shell'
import type {
  ShellBackendSelection,
  ShellEntryStatus,
  ShellRegistryDocument,
  ShellRegistryEntry,
} from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import SandboxPwshExecutor from '@deepseek-ai/dsh-pwsh-sandbox'

/** Router configuration; `defaultFamily` mirrors the boot flag when omitted. */
export interface Config {
  /** Family unstamped requests address; defaults to the boot-resolved selection. */
  defaultFamily?: ShellBackendSelection
  /**
   * Composition entries handed to each mounted family executor verbatim —
   * the shape each family's own plugin config accepts. The retired bare
   * executor rows carried these; the router row carries them now.
   */
  families?: {
    /** Composition entry handed verbatim to the bash family executor. */
    bash?: unknown
    /** Composition entry handed verbatim to the pwsh family executor. */
    pwsh?: unknown
  }
}

/** Constructor of one family executor; tests substitute failing doubles. */
export type FamilyExecutorPlugin = new (ctx: Context, config: never) => ShellExecutor

/** Tags the family a router's {@link ShellExecutor.resolve} selected. */
export const ROUTED_FAMILY: unique symbol = Symbol('shell-router.family')

/** A resolved spec carrying the family its resolver selected. */
export interface RoutedSpec extends ShellExecSpec {
  /** Set by the router; the family executor reads only its own fields. */
  [ROUTED_FAMILY]?: ShellBackendSelection
}

/** Live availability of every shell family — and registry entry — on this host. */
export interface ShellAvailability {
  /** Family unstamped requests address. */
  readonly default: ShellBackendSelection
  /** Registry id of the entry unstamped requests run. */
  readonly defaultEntry: string
  /** Whether each family's executor mounted successfully. */
  readonly families: Readonly<Record<ShellBackendSelection, boolean>>
  /** Probe status of every addressable registry entry, builtins first. */
  readonly entries: readonly ShellEntryStatus[]
}

/**
 * Resolve the default family the way the boot bridge does: explicit config,
 * then the published `$DSH_SHELL_BACKEND`, then the platform default.
 * @param config - the router's composition config.
 * @param env - environment mapping holding the published flag.
 * @param platform - platform the fallback resolves against.
 * @returns the family unstamped requests address.
 */
export function resolveDefaultFamily(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ShellBackendSelection {
  if (config.defaultFamily !== undefined) return config.defaultFamily
  const published = env[SHELL_BACKEND_ENV]
  if (published === 'bash' || published === 'pwsh') return published
  return resolveShellBackend(platform, 'platform-default')
}

/** The registry document as the router sees it: the service's, else the empty registry. */
function registryDocument(ctx: Context): ShellRegistryDocument {
  const service = ctx.get('shellRegistry') as { document(): ShellRegistryDocument } | undefined
  return service === undefined ? { default: PLATFORM_DEFAULT_ID, entries: [] } : service.document()
}

/** One probe outcome before availability shape is applied. */
interface ProbedEntry {
  status: ShellEntryStatus
  resolvedPath: string | undefined
}

/**
 * The multi-family `ctx.shell` provider. Extends the seam so every existing
 * consumer holds; probes each servable shell binary (the platform builtins
 * and every registry entry), mounts each family an available shell routes to
 * in an isolated scope (`shell` for the registration, `settings` for the
 * shared-namespace exemption), and routes per request.
 */
export class ShellRouter extends ShellExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  static Config: z<Config> = z.object({
    defaultFamily: z.union([z.const('bash'), z.const('pwsh')]),
    families: z.object({
      bash: z.any(),
      pwsh: z.any(),
    }),
  })

  /** The family table; protected so tests substitute failing doubles. */
  protected readonly familyPlugins: Readonly<Record<ShellBackendSelection, FamilyExecutorPlugin>> = {
    bash: SandboxBashExecutor,
    pwsh: SandboxPwshExecutor,
  }

  /** The mounted family executors; protected so specialized hosts and tests seed stubs. */
  protected readonly mounted = new Map<ShellBackendSelection, ShellExecutor>()
  /** The boot-resolved family untagged requests route to. */
  readonly defaultFamily: ShellBackendSelection

  /** Per-family composition entries forwarded at mount; protected for specialized hosts. */
  protected readonly executorConfig: Config['families']

  /** Probe outcomes by entry id; empty until {@link Service.init} settles. */
  private readonly probed = new Map<string, ProbedEntry>()

  /** The registry entry id unstamped requests run; settled by {@link Service.init}. */
  private defaultEntryId: string

  /** Whether a config flag or published env pinned the default stack. */
  private readonly stackPinned: boolean

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.defaultFamily = resolveDefaultFamily(config)
    this.executorConfig = config.families
    this.stackPinned = config.defaultFamily !== undefined
      || process.env[SHELL_BACKEND_ENV] === 'bash' || process.env[SHELL_BACKEND_ENV] === 'pwsh'
    const builtins = builtinRegistryEntries(process.platform)
    this.defaultEntryId = (this.defaultFamily === 'pwsh' ? builtins.pwsh : builtins.bash).id
  }

  /** The effective default family's advertisement; executors are sandboxed alike. */
  override get sandboxMode(): SandboxMode | undefined {
    return this.mounted.get(this.effectiveDefault())?.sandboxMode
  }

  /**
   * Probe every addressable shell (platform builtins and registry entries),
   * then mount each family a probe serves. The effective default family
   * mounts in a settings-visible scope and its executor installs the shared
   * `shell` settings section at host level — the shell card and hot reload
   * behave exactly as on a single-executor host. Every OTHER family isolates
   * `settings` as well: the executors share one namespace, so a second
   * registration would throw; the non-default family runs its composition
   * config. A family no probed shell routes to — or whose stack cannot
   * mount — stays unavailable with a warning while the other serves; a host
   * with neither cannot boot routed.
   */
  protected async [Service.init](): Promise<void> {
    const selections: ShellBackendSelection[] = ['bash', 'pwsh']
    const registry = registryDocument(this.ctx)
    const index = registryEntryIndex(process.platform, registry)
    type ProbeTarget = { id: string; label: string; stack: ShellBackendSelection; path: string }
    const customTargets: ProbeTarget[] = registry.entries.flatMap((entry: ShellRegistryEntry): ProbeTarget[] => {
      // The index skips unclassifiable executables (and settings validation
      // rejects them earlier still); an index miss means nothing to probe.
      const indexed = index.get(entry.id)
      return indexed === undefined ? [] : [{ id: indexed.id, label: indexed.label, stack: indexed.stack, path: indexed.path }]
    })
    const builtins = builtinRegistryEntries(process.platform)
    const probeTargets: readonly ProbeTarget[] = [builtins.bash, builtins.pwsh, ...customTargets]
    await Promise.all(probeTargets.map(async (target) => {
      try {
        const resolvedPath = await this.ctx.subprocess.resolveExecutable(target.path)
        this.probed.set(target.id, { status: { ...target, available: true, resolvedPath }, resolvedPath })
      } catch (error: unknown) {
        this.probed.set(target.id, { status: { ...target, available: false, reason: String(error) }, resolvedPath: undefined })
      }
    }))
    const serves = (family: ShellBackendSelection): boolean =>
      [...this.probed.values()].some(probe => probe.status.stack === family && probe.status.available)
    // The probe RANKS, it does not gate: a stripped environment (empty PATH,
    // minimal containers) fails every probe while the families would still
    // mount and serve — exactly like the single-executor hosts this router
    // replaces, whose exec failures surface per command. Only a family that
    // probed AND fails to MOUNT stays unavailable.
    let effective: ShellBackendSelection | undefined = serves(this.defaultFamily)
      ? this.defaultFamily
      : selections.find(serves)
    if (effective === undefined) {
      effective = this.defaultFamily
      this.ctx.logger.warn(`shell-router: no shell binary probed on this host; mounting the "${effective}" family unprobed`)
    }
    for (const family of selections) {
      if (!serves(family) || family === effective) continue
      await this.mountFamily(family, effective)
    }
    // The effective default mounts last so `effectiveDefault()` settles
    // before its executor installs the host-level settings section.
    await this.mountFamily(effective, effective)
    if (this.mounted.size === 0) {
      throw new Error(`shell-router: no shell family could mount (probed ${selections.join(', ')})`)
    }
    if (this.mounted.get(this.defaultFamily) === undefined) {
      this.ctx.logger.warn(`shell-router: default family "${this.defaultFamily}" is unavailable; unstamped requests address "${this.effectiveDefault()}"`)
    }
    this.defaultEntryId = this.resolveDefaultEntryId(registry)
  }

  /** The default entry per the single precedence: pin, registry default, builtin. */
  private resolveDefaultEntryId(registry: ShellRegistryDocument): string {
    if (!this.stackPinned) {
      const requested = registry.default === LEGACY_BASH_FAMILY_ID ? BUILTIN_POSIX_ID : registry.default
      if (requested !== PLATFORM_DEFAULT_ID) {
        const probe = this.probed.get(requested)
        if (probe?.status.available === true && this.mounted.has(probe.status.stack)) return requested
      }
    }
    const builtins = builtinRegistryEntries(process.platform)
    return (this.effectiveDefault() === 'pwsh' ? builtins.pwsh : builtins.bash).id
  }

  /** Mount one family in its own scope; only the non-default isolates settings. */
  private async mountFamily(family: ShellBackendSelection, effective: ShellBackendSelection): Promise<void> {
    try {
      // Each family gets its own labels for both isolated names, so the two
      // scopes never see each other's `shell` registration.
      const scope = family === effective
        ? this.ctx.isolate('shell')
        : this.ctx.isolate('shell').isolate('settings')
      const entry = this.executorConfig?.[family]
      await scope.plugin(this.familyPlugins[family], (entry === undefined ? {} : entry) as never)
      const executor = scope.get('shell')
      if (executor === undefined) throw new Error('the family executor did not register ctx.shell')
      this.mounted.set(family, executor)
    } catch (error: unknown) {
      this.ctx.logger.warn(`shell-router: the ${family} shell family failed to mount: ${String(error)}`)
    }
  }

  /**
   * Which shells this host serves, for the session-level selector: the
   * effective default family and entry, family mount status, and every
   * addressable entry's probe outcome.
   * @returns the effective defaults and per-shell availability.
   */
  availability(): ShellAvailability {
    return {
      default: this.effectiveDefault(),
      defaultEntry: this.defaultEntryId,
      families: {
        bash: this.mounted.has('bash'),
        pwsh: this.mounted.has('pwsh'),
      },
      entries: [...this.probed.values()].map(probe => probe.status),
    }
  }

  override resolve(request: ShellExecRequest): RoutedSpec {
    const family = request.family ?? this.effectiveDefault()
    const executor = this.executorFor(family, 'resolve')
    const spec = Object.assign(executor.resolve(request), { [ROUTED_FAMILY]: family })
    // One materialization rule: a caller-stamped executable wins; otherwise
    // the default entry's probed path — never a PATH re-resolution — when the
    // default entry routes to this family.
    if (spec.shellPath === undefined && family === this.effectiveDefault()) {
      const materialized = this.probed.get(this.defaultEntryId)?.resolvedPath
      if (materialized !== undefined
        && this.probed.get(this.defaultEntryId)?.status.stack === family) {
        spec.shellPath = materialized
      }
    }
    return spec
  }

  override run(spec: RoutedSpec): Promise<ShellRunResult> {
    return this.executorFor(this.familyOf(spec), 'run').run(spec)
  }

  override start(spec: RoutedSpec): ShellProcess | Promise<ShellProcess> {
    return this.executorFor(this.familyOf(spec), 'start').start(spec)
  }

  /** The family a spec carries, or the effective default for foreign specs. */
  private familyOf(spec: RoutedSpec): ShellBackendSelection {
    return spec[ROUTED_FAMILY] ?? this.effectiveDefault()
  }

  /** The default family when it mounted, else the single mounted alternative. */
  private effectiveDefault(): ShellBackendSelection {
    if (this.mounted.has(this.defaultFamily)) return this.defaultFamily
    const [only] = [...this.mounted.keys()]
    return only ?? this.defaultFamily
  }

  /** Fetch one family's executor; a clear error names the unavailable family. */
  private executorFor(family: ShellBackendSelection, operation: string): ShellExecutor {
    const executor = this.mounted.get(family)
    if (executor === undefined) {
      throw new Error(`shell-router: the ${family} shell family is unavailable on this host (during ${operation})`)
    }
    return executor
  }
}

export default ShellRouter
