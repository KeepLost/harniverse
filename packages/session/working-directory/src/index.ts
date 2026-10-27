/**
 * Session working directories: one logged effective directory per session,
 * validated through the mounted filesystem provider, with recovery to the
 * original project and model-visible change notices.
 *
 * @module @deepseek-ai/dsh-working-directory
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Config } from './types.ts'

export type { Config, WorkingDirectoryChange, WorkingDirectoryProjection } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workingDirectory: WorkingDirectoryService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Committed working-directory transition notices.
     * @persistenceAttribution
     */
    'working-directory': { kind: 'working-directory' }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Effective working directory; the immutable session header retains the
     * original project directory. Whole-value payload: the complete
     * post-change directory, never a bare delta.
     */
    'working-directory/change': import('./types.ts').WorkingDirectoryChange
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded current directory for session observations, or null when none is recorded. */
    workingDirectory: import('./types.ts').WorkingDirectoryProjection
  }
}

/** Wire payload schema of the `workingDirectory` projection. */
const workingDirectorySchema: ZodType<string | null> = zod.string().min(1).nullable()

/** Fold the durable directory stream: last committed change wins. */
function applyWorkingDirectory(state: string | null, event: SessionEvent): string | null {
  return event.type === 'working-directory/change' ? event.data.cwd : state
}

/** One owner for each session's effective directory and its model-visible changes. */
export class WorkingDirectoryService extends Service {
  static inject = ['fs', 'sessionProjections']

  static Config: z<Config> = z.object({
    defaultDirectory: z.string(),
  })

  /** Absolute deployment fallback for sessions with no recorded original directory. */
  readonly defaultDirectory: string
  private readonly pending = new WeakMap<Session, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly lifecycle = new AbortController()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workingDirectory')
    const directory = config.defaultDirectory ?? process.cwd()
    if (!isAbsolute(directory)) throw new Error('working-directory: defaultDirectory must be absolute')
    this.defaultDirectory = directory

    ctx.sessionProjections.register<'workingDirectory', string | null>({
      key: 'workingDirectory',
      schema: workingDirectorySchema,
      init: () => null,
      apply: applyWorkingDirectory,
      view: state => state,
      stateVersion: 1,
    })
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'working-directory:current',
        order: 108,
        text: (context) => {
          const session = context.agent?.session
          return session === undefined ? '' : this.contextText(session)
        },
      })
    })
    ctx.effect(() => async () => {
      this.lifecycle.abort(new Error('working-directory service disposed'))
      await Promise.allSettled(this.operations)
    })
  }

  /**
   * Read the committed directory without filesystem I/O.
   * @param session - session whose directory is requested.
   * @returns its effective absolute directory.
   */
  get(session: Session): string {
    return this.recorded(session) ?? session.header.cwd ?? this.defaultDirectory
  }

  /**
   * Validate the current directory and restore the original project when it
   * disappeared. A session that never recorded a change commits its implicit
   * starting directory so replay and resume carry it.
   * @param agent - live agent owning the session.
   * @param signal - cancellation for filesystem inspection.
   * @returns the existing directory; recovery is committed before fulfillment.
   * A notice failure is warned without reverting the committed state.
   * @throws when neither the current nor the original directory exists.
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
      const current = this.get(agent.session)
      if (await this.isDirectory(current, control)) {
        if (this.recorded(agent.session) === null) {
          agent.session.append('working-directory/change', { cwd: current })
        }
        return current
      }
      const original = agent.session.header.cwd ?? this.defaultDirectory
      const restored = await this.canonicalDirectory(original, undefined, control)
      this.commit(agent, restored, true, control)
      return restored
    })
  }

  /**
   * Change one session's directory without changing existing processes or
   * write permissions.
   * @param agent - live agent owning the session.
   * @param path - absolute path or a path relative to the current directory.
   * @param signal - cancellation before the durable change.
   * @returns the canonical absolute directory, committed before fulfillment.
   * @throws when the requested path is not an existing directory.
   */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
      if (path.length === 0) throw new Error('working-directory: cd must not be empty')
      const directory = await this.canonicalDirectory(path, this.get(agent.session), control)
      this.commit(agent, directory, false, control)
      return directory
    })
  }

  /** Projection snapshot value for one session, or null before the first change. */
  private recorded(session: Session): string | null {
    return this.ctx.sessionProjections.snapshot(session).values.workingDirectory ?? null
  }

  private contextText(session: Session): string {
    return `Current working directory: ${JSON.stringify(this.get(session))}.`
  }

  private async isDirectory(path: string, signal: AbortSignal): Promise<boolean> {
    const target = await this.ctx.fs.resolve(path, { signal })
    const info = await this.ctx.fs.stat(target, signal)
    return info?.type === 'directory'
  }

  private async canonicalDirectory(path: string, cwd: string | undefined, signal: AbortSignal): Promise<string> {
    const target = await this.ctx.fs.resolve(path, { ...cwd === undefined ? {} : { cwd }, signal })
    const info = await this.ctx.fs.stat(target, signal)
    if (info?.type !== 'directory') {
      throw new Error(`working-directory: directory does not exist: ${JSON.stringify(path)}`)
    }
    return this.ctx.fs.processPath(target)
  }

  private commit(agent: Agent, directory: string, recovered: boolean, signal: AbortSignal): void {
    signal.throwIfAborted()
    agent.ctx.fiber.assertActive()
    const previous = this.get(agent.session)
    if (previous === directory) return
    agent.session.append('working-directory/change', { cwd: directory })
    const notice = createUserMessage({
      content: [{
        type: 'text',
        text: recovered
          ? `The working directory ${JSON.stringify(previous)} is unavailable. The working directory is now ${JSON.stringify(directory)}.`
          : `The working directory changed from ${JSON.stringify(previous)} to ${JSON.stringify(directory)}.`,
      }],
      source: { kind: 'working-directory' },
    })
    try {
      agent.inject(notice)
    } catch (error) {
      this.ctx.logger.warn(`working-directory: committed ${JSON.stringify(directory)}, but could not queue its notice: ${String(error)}`)
    }
  }

  private serialize<T>(agent: Agent, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const session = agent.session
    const control = signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([this.lifecycle.signal, signal])
    const operation = (this.pending.get(session) ?? Promise.resolve()).then(() => {
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      return action(control)
    })
    const settled = operation.finally(() => this.operations.delete(settled))
    this.operations.add(settled)
    this.pending.set(session, settled.then(() => {}, () => {}))
    return settled
  }
}

/**
 * Effective directory for a calling agent: the working-directory owner's
 * committed value when its service is mounted, else the immutable header cwd.
 * @param agent - calling agent, when one exists.
 * @returns the effective absolute directory, or undefined for agentless calls.
 */
export function effectiveCwd(agent: Agent | undefined): string | undefined {
  if (agent === undefined) return undefined
  // Narrow once: partial test doubles may omit `ctx`; the runtime tolerates them.
  const ctx = agent.ctx as Context | undefined
  return ctx?.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd
}

export default WorkingDirectoryService
