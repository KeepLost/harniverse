/**
 * Model selection plugin, browser half — the /model popupSelect contribution
 * and the composer's named `conversation.input.model` seat over ONE
 * per-session directory owned by ModelDirectoryResolver
 * (`ctx.modelDirectories`), plus the new-session model-profile chip
 * (`conversation.hero.modelProfile`). The first two load the session's
 * provider-grouped advisory directory (`session.models`) and submit through
 * `session.selectModel` via the same directory instance,
 * so the host-reported current selection is the single fact both surfaces echo
 * — a switch made in either entry is what the other shows next. Failures
 * ride each entry's own retry surface (popup shell error/retry; seat menu
 * inline error) without forking the state. Addressed subagent sessions expose
 * neither entry because those Agent-bound RPCs would activate persisted
 * history outside the direct-parent continuation path.
 */
// Type-only: the carrier types, the forwarded Host-event face and the ctx.remote merge.
import type { ModelSelection, SessionId, SessionModels } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.model seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from './directory.ts'
import { ModelDirectoryResolver } from './service.ts'
import type { ModelSelectInjected } from './slots.ts'
import { ModelSelect } from './ModelSelect.tsx'
import { ModelProfileSeat } from './ModelProfileSeat.tsx'
import type { ModelProfileSeatInjected } from './ModelProfileSeat.tsx'
import { ModelProfileSeatController } from './hero-store.ts'
import type { SeatSessionSummary } from './hero-store.ts'
import { en, zh, type ModelKey } from './locales.ts'

export { ModelDirectory } from './directory.ts'
export type { ModelDirectoryState } from './directory.ts'
export { ModelDirectoryResolver } from './service.ts'
export type { ModelSelectInjected } from './slots.ts'
export type { ModelProfileSeatState, ModelProfileOption, SeatSessionSummary } from './hero-store.ts'
export type { ModelProfileSeatInjected, ModelProfileSeatProps } from './ModelProfileSeat.tsx'
export type { ModelKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The model selection surfaces' copy (/model popup + composer seat). */
    model: ModelKey
  }
}

/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
function rowId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/** Flatten the directory into popup rows; failure rows are listed for visibility but never selectable. */
function optionsOf(directory: SessionModels, t: TranslateNS<'model'>): SelectOption[] {
  const rows: SelectOption[] = []
  for (const group of directory.groups) {
    for (const model of group.models) {
      rows.push({
        id: rowId(group.id, model.id),
        label: model.name,
        detail: model.description !== undefined ? `${group.name} · ${model.description}` : group.name,
        ...(directory.current.provider === group.id && directory.current.model === model.id
          ? { active: true } : {}),
      })
    }
  }
  for (const failure of directory.failures) {
    rows.push({
      id: `failure/${failure.id}`,
      label: failure.name,
      detail: t('option.loadError', { message: failure.message }),
    })
  }
  return rows
}

/**
 * Resolve a picked row back to its model selection by matching against the loaded
 * groups (the same data the rows were built from — ids stay opaque).
 * @param state - the session's directory snapshot.
 * @param id - the picked row id.
 * @returns the row's model selection, or undefined for failure rows / stale ids.
 */
function selectionOf(state: ModelDirectoryState, id: string): ModelSelection | undefined {
  for (const group of state.groups) {
    for (const model of group.models) {
      if (rowId(group.id, model.id) !== id) continue
      const sameRoute = state.current?.provider === group.id && state.current.model === model.id
      const reasoningEffort = sameRoute
        ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort
        : model.reasoning?.defaultEffort
      return {
        provider: group.id,
        model: model.id,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      }
    }
  }
  return undefined
}

/** Dictionary namespace owned by this plugin. */
const NS = 'model'

/** Required services: the contribution registry, the seat's slot registry, locale, and the service's own faces. */
export const inject = ['commandUi', 'connection', 'locale', 'sessions', 'slots', 'remote']

/**
 * Client plugin body: mount ModelDirectoryResolver, register the `model` dictionaries,
 * then register the /model popup contribution and the composer model seat
 * over the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-model-selection: dictionaries')

  // Non-slot faces (the command description, the popup option builder) read
  // through the bound translate; the seat component reads the standard seat.
  const t = ctx.locale.bind(NS)

  // The composer-block reason is this plugin's own copy, read at raise time so
  // a locale change reaches the next publish.
  ctx.plugin(ModelDirectoryResolver, { blockReason: () => t('blocked.composer') })

  // Entry 1: the /model popupSelect over the shared directory. The command
  // description is registry-held text: it reads t() once at registration and
  // refreshes only on re-registration, not on locale change.
  ctx.inject(['commandUi', 'modelDirectories'], (scope: ClientContext) => {
    const command = scope.get('commandUi') as CommandUiContract
    const models = scope.modelDirectories
    const sessions = scope.sessions
    scope.effect(() => command.register({
      name: 'model',
      description: t('command.description'),
      available: session => sessions.subagentAddress(session.sessionId) === undefined,
      ui: {
        kind: 'popupSelect',
        options: async (session) => {
          if (sessions.subagentAddress(session.sessionId) !== undefined) {
            throw new Error('model selection is unavailable for addressed subagent sessions')
          }
          return optionsOf(await models.directoryFor(session.sessionId).load(), t)
        },
        onSelect: async (option, session) => {
          if (sessions.subagentAddress(session.sessionId) !== undefined) {
            throw new Error('model selection is unavailable for addressed subagent sessions')
          }
          const directory = models.directoryFor(session.sessionId)
          const selection = selectionOf(directory.store.getSnapshot(), option.id)
          if (selection === undefined) {
            throw new Error('this provider\'s catalog failed to load — pick a model from a loaded group')
          }
          await directory.select(selection)
        },
      },
    }), 'ui-model-selection: /model contribution')
  })

  // Entry 2: the composer's named model seat over the SAME directory —
  // one directory, one selection verb.
  ctx.inject(['slots', 'modelDirectories'], (scope: ClientContext) => {
    const models = scope.modelDirectories
    const sessions = scope.sessions
    const seatInject = (sessionId: SessionId): ModelSelectInjected => {
      const directory = models.directoryFor(sessionId)
      const available = sessions.subagentAddress(sessionId) === undefined
      return {
        available,
        directory: directory.store,
        load: () => {
          if (available) directory.load().catch(() => { /* surfaced on the store */ })
        },
        select: (selection: ModelSelection) => available
          ? directory.select(selection).then(() => true, () => false)
          : Promise.resolve(false),
        selectProfile: (profileId: string) => available
          ? directory.selectProfile(profileId).then(() => true, () => false)
          : Promise.resolve(false),
        selectRoute: (routeId: string) => available
          ? directory.selectRoute(routeId).then(() => true, () => false)
          : Promise.resolve(false),
      }
    }
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      locale: NS,
      inject: seatInject,
    }, ModelSelect))
  })

  // Entry 3: the new-session model-profile chip. The pick applies live to the
  // current blank session (a Model Profile is mutable per session), or starts
  // a distinct session carrying it when none is current.
  ctx.inject(['slots', 'sessions', 'workspaces'], (scope: ClientContext) => {
    const api = (scope.get('connection') as ConnectionHandle).api
    const workspaces = scope.get('workspaces') as IWorkspaces
    const seat = new ModelProfileSeatController(
      api,
      (): SeatSessionSummary | undefined => {
        const state = scope.sessions.list.getSnapshot()
        const summary = state.current === undefined ? undefined : state.byId[state.current]
        return summary === undefined ? undefined : { id: summary.id, blank: summary.blank }
      },
      (modelProfile: string) => { workspaces.startSession(undefined, undefined, modelProfile) },
    )
    const seatInject = (): ModelProfileSeatInjected => ({
      hooks: { modelProfileSeat: seat.store },
      load: () => seat.load(),
      refreshSession: () => seat.refreshSession(),
      apply: () => seat.apply(),
      select: (id: string) => { seat.select(id) },
    })
    scope.effect(() => {
      // Connecting a workspace reuses or creates a session after the pick, so
      // the stage is reconciled when the session arrives — and the tracked
      // profile follows every current-session move.
      const stop = scope.sessions.list.subscribe(() => {
        void seat.refreshSession().then(() => seat.apply())
      })
      // The roster is a settings document, so an edit from the settings page
      // must reach the screen that starts the next session.
      const settingsMoved = scope.remote.$on('settings/document-updated', (ns: string) => {
        if (ns !== 'model-policy') return
        void seat.load()
      })
      const chip = scope.slots.register({
        name: 'conversation.hero.modelProfile',
        locale: NS,
        inject: seatInject,
      }, ModelProfileSeat)
      return () => {
        stop()
        settingsMoved()
        chip()
      }
    }, 'ui-model-selection: new-session model-profile chip')
  })
}
