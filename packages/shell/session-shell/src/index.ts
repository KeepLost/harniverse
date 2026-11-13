/**
 * Session-scoped shell selection: one durable per-session registry-entry
 * override over the host's boot-resolved default. The selection takes effect
 * at the NEXT model request — the shell fact rides the runtime-context
 * snapshot plane (a partial snapshot supersedes earlier ones), and the
 * inactive stack's tool disappears from that same request's catalog through
 * a per-agent `tools.restrict` — one visibility resolver feeding
 * presentation, lookup, and dispatch, so calls already in flight complete
 * while new calls to the retired tool fail as unknown.
 *
 * Three hard rules keep the model's belief and the executor aligned:
 * 1. ONE source: the prompt fact, the tool-catalog restriction, and the
 *    execution stamp all derive from {@link resolveEffectiveShell} — no
 *    consumer resolves a shell on its own.
 * 2. ONE materialization: each prompt assembly freezes the effective
 *    shell (the "promise") the fact announces; tool dispatches execute the
 *    promise, never a live re-read, so a mid-request switch cannot make a
 *    call run a shell the model was not told about.
 * 3. Fail closed: an unavailable target degrades inside the resolver with a
 *    reported reason, and the degraded fact names the shell that actually
 *    runs — never a silent substitution.
 *
 * Both stacks keep running underneath (executors, persistent shells,
 * background jobs are stack-neutral or stack-owned and never torn down);
 * switching is a pure pointer change.
 * @module @deepseek-ai/dsh-session-shell
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { BUILTIN_POSIX_ID, BUILTIN_PWSH_ID, PLATFORM_DEFAULT_ID, resolveEffectiveShell } from '@deepseek-ai/dsh-shell'
import type { EffectiveShell, ShellBackendSelection, ShellEntryStatus, ShellRegistryDocument } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** The contributed context's registry name. */
export const SESSION_SHELL_CONTEXT = 'session-shell:current'

/** Prompt order: immediately before the working-directory context (108). */
export const SESSION_SHELL_ORDER = 107

/** Pinned notice naming a switch the model must not miss; labels interpolate. */
export const SHELL_CHANGE_NOTICE = 'The session shell changed from {from} to {to}; shell commands now run under {to}.'

/** The other stack: the tool a selection retires. */
const otherStack = (stack: ShellBackendSelection): ShellBackendSelection =>
  stack === 'bash' ? 'pwsh' : 'bash'

/** Structural shape of the registry service the composition may carry. */
interface RegistrySource {
  document(): ShellRegistryDocument
}

/** The registry document as this service reads it: the service's, else empty. */
const emptyRegistry: ShellRegistryDocument = { default: PLATFORM_DEFAULT_ID, entries: [] }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Effective shell entry for the session; whole-value payload — the
     * complete post-change entry id, never a bare delta.
     */
    'session-shell/change': import('./types.ts').SessionShellChange
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded current shell entry for session observations, or null when none is recorded. */
    sessionShell: import('./types.ts').SessionShellProjection
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionShell: SessionShellService
  }
}

/** Wire payload schema of the `sessionShell` projection. */
const sessionShellSchema: ZodType<string | null> = zod.string().nullable()

/** The builtin id a legacy family value folds onto ('pwsh' is already a builtin id). */
const foldLegacyEntry = (entry: string): string =>
  entry === 'bash' ? BUILTIN_POSIX_ID : entry === 'pwsh' ? BUILTIN_PWSH_ID : entry

/** Fold the durable entry stream: last committed change wins, legacy values fold. */
function applySessionShell(state: string | null, event: SessionEvent): string | null {
  if (event.type !== 'session-shell/change') return state
  const data = event.data as { entry?: unknown; family?: unknown }
  if (typeof data.entry === 'string') return foldLegacyEntry(data.entry)
  if (typeof data.family === 'string') return foldLegacyEntry(data.family)
  return null
}

/** Structural shape of a routed shell seam: only the router answers `availability()`. */
interface RoutedShell {
  availability(): {
    default: ShellBackendSelection
    defaultEntry: string
    families: { bash: boolean; pwsh: boolean }
    entries: readonly ShellEntryStatus[]
  }
}

/**
 * Structural router detection: `availability()` exists only on the shell
 * router. A class-identity check would break whenever the service and the
 * router load from different module graphs (source vs built lib) — the
 * plugin-native seam is structural, so detection is too.
 */
function isRoutedShell(shell: unknown): shell is RoutedShell {
  return shell !== undefined && typeof (shell as RoutedShell).availability === 'function'
}

/** The dispatch promise a request froze: what the model was told, what runs. */
export interface DispatchTarget {
  /** The promised entry's registry id. */
  entryId: string
  /** The promised stack — the tool that must serve the call. */
  stack: ShellBackendSelection
  /**
   * The promised executable — the exact path executions spawn — or absent
   * when the entry never probed and its configured path is a bare name:
   * the executor then resolves through its own platform knowledge.
   */
  executablePath: string | undefined
}

/**
 * The session-scoped shell pointer: which registry entry a session's next
 * model request runs under, with durable switching, request-frozen dispatch
 * promises, per-agent tool restriction swaps, and the runtime-context fact
 * that announces it.
 */
export class SessionShellService extends Service {
  static inject = ['sessionProjections', 'tools', 'agents']

  private readonly pending = new WeakMap<Agent, Promise<void>>()
  private readonly restrictions = new WeakMap<Agent, () => void>()
  /**
   * The last entry this service committed per session, kept because the
   * projection folds an appended event only on dispatch — a rapid second
   * switch must observe the first without waiting for it.
   */
  protected readonly committed = new WeakMap<Session, string>()
  /** The promise each agent's CURRENT request froze; seeded at agent birth. */
  private readonly promises = new WeakMap<Agent, EffectiveShell>()
  /** The entry id the agent's PREVIOUS request announced, for change notices. */
  private readonly announced = new WeakMap<Agent, string>()

  constructor(ctx: Context) {
    super(ctx, 'sessionShell')
    ctx.sessionProjections.register<'sessionShell', string | null>({
      key: 'sessionShell',
      schema: sessionShellSchema,
      init: () => null,
      apply: applySessionShell,
      view: state => state,
      stateVersion: 2,
    })
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: SESSION_SHELL_CONTEXT,
        order: SESSION_SHELL_ORDER,
        text: (context) => {
          const agent = context.agent
          if (agent === undefined) return ''
          // ONE materialization per assembly: the promise this fact announces
          // is the promise tool dispatches execute. Re-freezing here is safe
          // because every `systemPrompt.assemble` consumer is model-visible
          // by contract — whenever the promise moves, the assembled text
          // carrying the matching fact reaches the model with it.
          const promise = this.freeze(agent)
          const previous = this.announced.get(agent)
          this.announced.set(agent, promise.entryId)
          if (previous !== undefined && previous !== promise.entryId) {
            const from = this.labelFor(previous)
            return `${promise.factText}\n${SHELL_CHANGE_NOTICE.replaceAll('{from}', from).replaceAll('{to}', promise.label)}`
          }
          return promise.factText
        },
      })
    })
    ctx.on('agent/created', ({ agent }) => {
      this.freeze(agent)
      this.applyRestriction(agent)
    })
  }

  /**
   * The label for a superseded entry: the frozen registry state at switch
   * time is gone, so the live probe table labels what it still serves, and
   * the entry id itself names what it no longer does. Called only for ids
   * that differ from the current promise (same-id switches announce no
   * notice).
   */
  private labelFor(previousEntryId: string): string {
    const router = this.ctx.get('shell')
    if (!isRoutedShell(router)) return previousEntryId
    return router.availability().entries.find(entry => entry.id === previousEntryId)?.label ?? previousEntryId
  }

  /** Freeze one agent's dispatch promise from the single resolver. */
  private freeze(agent: Agent): EffectiveShell {
    const effective = this.effective(agent.session)
    this.promises.set(agent, effective)
    return effective
  }

  /**
   * Read one session's effective shell through the single resolver, without
   * host I/O.
   * @param session - session whose selection is requested.
   * @returns the effective entry, stack, materialized executable, and fact.
   */
  effective(session: Session): EffectiveShell {
    const recorded = this.committed.get(session)
      ?? foldLegacyEntry(this.ctx.sessionProjections.snapshot(session).values.sessionShell ?? PLATFORM_DEFAULT_ID)
    return this.resolveWith(recorded)
  }

  /**
   * The host's default effective shell — no session override — for host-level
   * reads like the creation drawer's selector.
   * @returns the default entry, stack, materialized executable, and fact.
   */
  defaultEffective(): EffectiveShell {
    return this.resolveWith(PLATFORM_DEFAULT_ID)
  }

  /** The registry document from the composed service, else the empty registry. */
  private registryDocument(): ShellRegistryDocument {
    return (this.ctx.get('shellRegistry') as RegistrySource | undefined)?.document() ?? emptyRegistry
  }

  /** Resolve one recorded override (or the platform-default marker) to the effective shell. */
  private resolveWith(recorded: string): EffectiveShell {
    const router = this.ctx.get('shell')
    const routed = isRoutedShell(router)
    const registry = this.registryDocument()
    // Precedence: the recorded switch, then — when nothing is recorded — the
    // routed default entry (which already folds the boot pins and the
    // registry default), else an explicit registry default, else the
    // platform split.
    const override = recorded !== PLATFORM_DEFAULT_ID
      ? recorded
      : routed
        ? router.availability().defaultEntry
        : registry.default !== PLATFORM_DEFAULT_ID
          ? foldLegacyEntry(registry.default)
          : null
    return resolveEffectiveShell({
      platform: process.platform,
      registry,
      override,
      availability: routed ? this.availabilityIndex(router) : undefined,
    })
  }

  /** The routed router's probe table indexed by entry id. */
  private availabilityIndex(router: RoutedShell): Map<string, ShellEntryStatus> {
    return new Map(router.availability().entries.map(status => [status.id, status]))
  }

  /**
   * The dispatch promise a request froze — the exact executable its tool
   * calls must stamp, and the stack whose tool must serve them.
   * @param agent - calling agent whose request promise is read.
   * @returns the frozen target; undefined before the agent's first freeze
   * (callers then stamp nothing and the executor default applies).
   */
  dispatchTarget(agent: Agent): DispatchTarget | undefined {
    const promise = this.promises.get(agent)
    return promise === undefined ? undefined : {
      entryId: promise.entryId,
      stack: promise.stack,
      executablePath: promise.executablePath,
    }
  }

  /**
   * Switch one agent's session to another registry entry. Effective at the
   * next model request: the runtime-context snapshot announces the new shell
   * (with an explicit change notice), and the retired stack's tool leaves
   * that request's catalog. Nothing is torn down — the other stack's
   * executors, persistent shells, and background jobs keep running
   * underneath; the in-flight request keeps its frozen promise.
   * @param agent - live agent owning the session.
   * @param entry - registry entry id to select.
   * @returns the committed entry id; a same-entry request commits nothing.
   * @throws when the entry is unavailable on this host, the host composes no
   * router, or the agent is no longer live.
   */
  async switch(agent: Agent, entry: string): Promise<string> {
    return this.serialize(agent, () => {
      agent.ctx.fiber.assertActive()
      if (this.ctx.agents.get(agent.id) !== agent) {
        throw new Error(`session-shell: agent "${agent.id}" is not live`)
      }
      const router = this.ctx.get('shell')
      if (!isRoutedShell(router)) {
        throw new Error('session-shell: this host composes a single shell executor; switching requires the shell router')
      }
      const status = this.availabilityIndex(router).get(foldLegacyEntry(entry))
      if (status === undefined || !status.available) {
        throw new Error(`session-shell: the "${entry}" shell is unavailable on this host`)
      }
      const target = foldLegacyEntry(entry)
      const current = this.committed.get(agent.session) ?? this.effective(agent.session).entryId
      if (current === target) return target
      agent.session.append('session-shell/change', { entry: target })
      this.committed.set(agent.session, target)
      // The projection folds the appended event on dispatch; pass the committed
      // stack directly so the restriction lands before any dispatch runs. The
      // in-flight request's frozen promise is untouched by design.
      this.applyRestriction(agent, status.stack)
      return target
    })
  }

  /**
   * Host capability read for the switch affordance: whether switching is
   * possible and which entries are usable.
   * @returns switchability plus per-entry availability.
   */
  describe(): { switchable: boolean; families: { bash: boolean; pwsh: boolean }; entries: readonly ShellEntryStatus[] } {
    const shell = this.ctx.get('shell')
    if (isRoutedShell(shell)) {
      const availability = shell.availability()
      return { switchable: true, families: availability.families, entries: availability.entries }
    }
    const stack = resolveEffectiveShell({
      platform: process.platform,
      registry: (this.ctx.get('shellRegistry') as RegistrySource | undefined)?.document() ?? emptyRegistry,
      override: null,
    }).stack
    return { switchable: false, families: { bash: stack === 'bash', pwsh: stack === 'pwsh' }, entries: [] }
  }

  /**
   * Point one agent's tool restriction at its request's promised stack. A
   * stack whose tool is not registered (single-stack host, or the row
   * disabled by composition) has nothing to retire.
   */
  private applyRestriction(agent: Agent, stack: ShellBackendSelection = this.effective(agent.session).stack): void {
    const denied = otherStack(stack)
    const previous = this.restrictions.get(agent)
    if (previous !== undefined) previous()
    // Only a scoped agent context can carry a per-agent restriction; a
    // root-context agent (structural test stubs) has nothing to retire.
    const scope = scopeOf(agent.ctx)
    if (scope === undefined) return
    if (!this.ctx.tools.has(denied, scope)) return
    const tools = agent.ctx.get('tools')
    if (tools === undefined) return
    this.restrictions.set(agent, tools.restrict({ deny: [denied] }))
  }

  /** Serialize per-agent mutations; a rejected operation leaves the queue drained. */
  private serialize<T>(agent: Agent, action: () => T | Promise<T>): Promise<T> {
    const prior = this.pending.get(agent) ?? Promise.resolve()
    const run = prior.then(action, action)
    const tail = run.then(() => undefined, () => undefined)
    this.pending.set(agent, tail)
    return run
  }
}

export default SessionShellService
