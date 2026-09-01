/** Independent per-session supervision mode for human-dependent operations. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { SupervisionSelect } from './types.ts'

export type { SupervisionSelect, SupervisionOption } from './types.ts'

export const name = 'supervision'
export const inject = ['systemPrompt']

/** Whether a session may wait for human-dependent operations. */
export type SupervisionMode = 'supervised' | 'unsupervised'

/** Supported per-session supervision modes. */
export const SUPERVISION_MODES: readonly SupervisionMode[] = ['supervised', 'unsupervised']

/** Stable result text returned when a human-dependent operation is blocked. */
export const UNSUPERVISED_INTERACTION_MESSAGE =
  'Human interaction is unavailable in unsupervised mode. Do not retry this approval or question. '
  + 'Continue independent work and include the required user decision in the final report.'

declare module '@deepseek-ai/cordis' {
  interface Context {
    supervision: SupervisionService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** The effective human-supervision mode selected for this session. */
    'supervision/mode': { mode: SupervisionMode; source?: 'delegation' }
  }
}

/** Return the last persisted supervision mode, or undefined before pinning.
 * @param events - session events to inspect from newest to oldest.
 * @returns the most recently persisted mode, if one exists.
 */
export function effectiveSupervisionMode(events: readonly SessionEvent[]): SupervisionMode | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'supervision/mode') return event.data.mode
  }
  return undefined
}

/** Append one session-owned supervision override.
 * @param session - session whose durable policy should change.
 * @param mode - new supervision mode.
 */
export function setSupervisionMode(session: Session, mode: SupervisionMode): void {
  session.append('supervision/mode', { mode })
}

function runtimeContext(mode: SupervisionMode): string {
  if (mode === 'supervised') {
    return 'Supervision mode: supervised. Human questions and approval requests are available when the task genuinely requires a user decision. Inspect and use available tools before asking the user for discoverable facts.'
  }
  return 'Supervision mode: unsupervised. Do not call tools that wait for a human decision, including approval, sandbox escalation, or user questions. Do not retry a blocked approval or question. Continue every independent part of the task and complete everything that does not depend on a user decision. If the task is already in plan mode, you may leave plan mode and execute the plan autonomously; do not enter plan mode from a non-plan session. In the final report, include both completed work and the remaining actions or decisions that require the user\'s approval or answer.'
}

/** Configures the deployment fallback for sessions without an event. */
export interface Config {
  /** Deployment fallback for sessions without a persisted supervision mode. */
  mode?: SupervisionMode
}

/** Service owning the durable supervision mode and its model-facing context. */
export class SupervisionService extends Service {
  static inject = ['sessions']

  static Config: z<Config> = z.object({
    mode: z.union(['supervised', 'unsupervised'] as const).default('supervised'),
  })

  /** Deployment fallback used when a session has no persisted mode. */
  readonly defaultMode: SupervisionMode

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'supervision')
    this.defaultMode = config.mode ?? 'supervised'

    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.context({
        name: 'supervision:policy',
        order: 117,
        text: ({ agent }) => runtimeContext(agent === undefined ? this.defaultMode : this.modeOf(agent.session)),
      })
    })

    ctx.on('session/created', (session) => { this.pinInitialMode(session) })
    for (const session of ctx.sessions.list()) this.pinInitialMode(session)

    ctx.inject(['sessionProjections'], (projectionCtx) => {
      const selectSchema = zod.object({
        options: zod.array(zod.object({
          value: zod.string().min(1),
          name: zod.string().min(1),
          description: zod.string().min(1),
        })),
        currentValue: zod.string().min(1),
      }) as unknown as zod.ZodType<SupervisionSelect>
      projectionCtx.sessionProjections.register<'supervision', { mode: SupervisionMode | null }>({
        key: 'supervision',
        schema: selectSchema,
        init: () => ({ mode: null }),
        apply: (state, event) => event.type === 'supervision/mode' ? { mode: event.data.mode } : state,
        view: state => this.selectFor(state.mode),
        stateVersion: 1,
      })
    })

    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'supervision',
        description: 'Switch supervised or unsupervised execution',
        input: { hint: '<supervised|unsupervised>' },
        handler: ({ agent, rawInput }) => {
          const mode = rawInput.trim()
          if (!SUPERVISION_MODES.includes(mode as SupervisionMode)) {
            return { kind: 'error', text: `unknown supervision mode "${mode}" (available: ${SUPERVISION_MODES.join(', ')})` }
          }
          this.set(agent.session, mode as SupervisionMode)
          return { kind: 'success', text: `supervision ${mode}` }
        },
      })
    })
  }

  /** Resolve a session's current mode from its durable event log.
   * @param session - session whose effective mode should be resolved.
   * @returns the session mode or the deployment fallback.
   */
  modeOf(session: Session): SupervisionMode {
    return effectiveSupervisionMode(session.events) ?? this.defaultMode
  }

  /** Whether a human-dependent operation may enter an answerer/provider.
   * @param session - session to evaluate, or undefined for the deployment fallback.
   * @returns whether human interaction is allowed.
   */
  allowsHumanInteraction(session?: Session): boolean {
    return (session === undefined ? this.defaultMode : this.modeOf(session)) === 'supervised'
  }

  /** Switch a live session and make the new policy visible on its next step.
   * @param session - live session whose mode should change.
   * @param mode - new supervision mode.
   */
  set(session: Session, mode: SupervisionMode): void {
    if (!SUPERVISION_MODES.includes(mode)) throw new TypeError(`unknown supervision mode ${JSON.stringify(mode)}`)
    if (this.modeOf(session) === mode) return
    setSupervisionMode(session, mode)
    const agent = this.ctx.get('agents')?.get(session.id)
    agent?.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `Supervision mode changed to "${mode}" (changed by the user).`,
      }],
      source: { kind: 'plugin', plugin: 'supervision' },
    }))
  }

  private pinInitialMode(session: Session): void {
    if (effectiveSupervisionMode(session.events) === undefined) setSupervisionMode(session, this.defaultMode)
  }

  private selectFor(mode: SupervisionMode | null): SupervisionSelect {
    return {
      options: [
        { value: 'supervised', name: 'Supervised', description: 'Allow configured user questions and approval requests.' },
        { value: 'unsupervised', name: 'Unsupervised', description: 'Continue independent work without waiting for human decisions.' },
      ],
      currentValue: mode ?? this.defaultMode,
    }
  }
}

export default SupervisionService
