/**
 * Session-scoped shell selection: one durable per-session family override
 * over the host's boot-resolved default. The selection takes effect at the
 * NEXT model request — the shell fact rides the runtime-context snapshot
 * plane (a partial snapshot supersedes earlier ones), and the inactive
 * family's tool disappears from that same request's catalog through a
 * per-agent `tools.restrict` — one visibility resolver feeding presentation,
 * lookup, and dispatch, so calls already in flight complete while new calls
 * to the retired tool fail as unknown.
 *
 * Both families keep running underneath (executors, persistent shells,
 * background jobs are family-neutral or family-owned and never torn down);
 * switching is a pure pointer change.
 * @module @deepseek-ai/dsh-session-shell
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveShellBackend } from '@deepseek-ai/dsh-shell'
import type { ShellBackendSelection } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** The contributed context's registry name. */
export const SESSION_SHELL_CONTEXT = 'session-shell:current'

/** Prompt order: immediately before the working-directory context (108). */
export const SESSION_SHELL_ORDER = 107

/** The model-facing shell fact per family, pinned verbatim. */
export const CONTEXT_TEXT: Readonly<Record<ShellBackendSelection, string>> = {
  bash: 'Current shell for commands: bash. Run shell commands with the `bash` tool; its syntax is POSIX shell.',
  pwsh: 'Current shell for commands: pwsh (PowerShell). Run shell commands with the `pwsh` tool; its syntax is PowerShell.',
}

/** The other family: the tool a selection retires. */
const otherFamily = (family: ShellBackendSelection): ShellBackendSelection =>
  family === 'bash' ? 'pwsh' : 'bash'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Effective shell family for the session; whole-value payload — the
     * complete post-change family, never a bare delta.
     */
    'session-shell/change': import('./types.ts').SessionShellChange
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded current shell family for session observations, or null when none is recorded. */
    sessionShell: import('./types.ts').SessionShellProjection
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionShell: SessionShellService
  }
}

/** Wire payload schema of the `sessionShell` projection. */
const sessionShellSchema: ZodType<ShellBackendSelection | null> = zod.enum(['bash', 'pwsh']).nullable()

/** Fold the durable family stream: last committed change wins. */
function applySessionShell(state: ShellBackendSelection | null, event: SessionEvent): ShellBackendSelection | null {
  return event.type === 'session-shell/change' ? event.data.family : state
}

/**
 * Owner of every session's effective shell family and its model-visible
 * enforcement. The override persists through the session log (the projection
 * rehydrates it on resume); the host default resolves live through the shell
 * router when one is composed.
 */
/** Structural shape of a routed shell seam: only the router answers `availability()`. */
interface RoutedShell {
  availability(): { families: { bash: boolean; pwsh: boolean }; default: ShellBackendSelection }
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

/**
 * The session-scoped shell family pointer: which family (bash | pwsh) a
 * session's next model request runs under, with durable switching, per-agent
 * tool restriction swaps, and the runtime-context fact that announces it.
 */
export class SessionShellService extends Service {
  static inject = ['sessionProjections', 'tools', 'agents']

  private readonly pending = new WeakMap<Agent, Promise<void>>()
  private readonly restrictions = new WeakMap<Agent, () => void>()
  /**
   * The last family this service committed per session, kept because the
   * projection folds an appended event only on dispatch — a rapid second
   * switch must observe the first without waiting for it.
   */
  private readonly committed = new WeakMap<Session, ShellBackendSelection>()

  constructor(ctx: Context) {
    super(ctx, 'sessionShell')
    ctx.sessionProjections.register<'sessionShell', ShellBackendSelection | null>({
      key: 'sessionShell',
      schema: sessionShellSchema,
      init: () => null,
      apply: applySessionShell,
      view: state => state,
      stateVersion: 1,
    })
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: SESSION_SHELL_CONTEXT,
        order: SESSION_SHELL_ORDER,
        text: (context) => {
          const session = context.agent?.session
          return session === undefined ? '' : CONTEXT_TEXT[this.family(session)]
        },
      })
    })
    ctx.on('agent/created', ({ agent }) => {
      this.applyRestriction(agent)
    })
  }

  /**
   * Read one session's effective family without host I/O.
   * @param session - session whose selection is requested.
   * @returns its override, or the host default when none is recorded.
   */
  family(session: Session): ShellBackendSelection {
    return this.ctx.sessionProjections.snapshot(session).values.sessionShell ?? this.hostDefault()
  }

  /**
   * Switch one agent's session to another shell family. Effective at the next
   * model request: the runtime-context snapshot announces the new family and
   * the retired tool leaves that request's catalog. Nothing is torn down —
   * the other family's executors, persistent shells, and background jobs keep
   * running underneath.
   * @param agent - live agent owning the session.
   * @param family - family to select.
   * @returns the committed family; a same-family request commits nothing.
   * @throws when the family is unavailable on this host, the host composes no
   * router, or the agent is no longer live.
   */
  async switch(agent: Agent, family: ShellBackendSelection): Promise<ShellBackendSelection> {
    return this.serialize(agent, () => {
      agent.ctx.fiber.assertActive()
      if (this.ctx.agents.get(agent.id) !== agent) {
        throw new Error(`session-shell: agent "${agent.id}" is not live`)
      }
      const router = this.ctx.get('shell')
      if (!isRoutedShell(router)) {
        throw new Error('session-shell: this host composes a single shell executor; switching requires the shell router')
      }
      if (!router.availability().families[family]) {
        throw new Error(`session-shell: the ${family} shell family is unavailable on this host`)
      }
      const current = this.committed.get(agent.session) ?? this.family(agent.session)
      if (current === family) return family
      agent.session.append('session-shell/change', { family })
      this.committed.set(agent.session, family)
      // The projection folds the appended event on dispatch; pass the committed
      // family directly so the restriction lands before any dispatch runs.
      this.applyRestriction(agent, family)
      return family
    })
  }

  /**
   * Host capability read for the switch affordance: whether switching is
   * possible and which families are usable. A single-executor host reports
   * only its boot default.
   * @returns switchability plus per-family availability.
   */
  describe(): { switchable: boolean; families: { bash: boolean; pwsh: boolean } } {
    const shell = this.ctx.get('shell')
    if (isRoutedShell(shell)) return { switchable: true, families: shell.availability().families }
    const single = this.hostDefault()
    return { switchable: false, families: { bash: single === 'bash', pwsh: single === 'pwsh' } }
  }

  /** The boot-shaped default: the router's effective family, else the platform split. */
  private hostDefault(): ShellBackendSelection {
    const shell = this.ctx.get('shell')
    return isRoutedShell(shell) ? shell.availability().default : resolveShellBackend(process.platform, 'platform-default')
  }

  /**
   * Point one agent's tool restriction at its session's family. A family
   * whose tool is not registered (single-family host, or the row disabled by
   * composition) has nothing to retire.
   */
  private applyRestriction(agent: Agent, family: ShellBackendSelection = this.family(agent.session)): void {
    const denied = otherFamily(family)
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
