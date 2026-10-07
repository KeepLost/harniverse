/**
 * The IM section's operation layer: it drives the `chatBots` Remote, the
 * model and preset catalogs, and the native directory picker, and publishes
 * every outcome through the store's bound actions. It holds no state of its
 * own beyond a read sequence; components receive its verbs as plain
 * callbacks through the inject face.
 * @module @deepseek-ai/dsh-client-ui-settings-im/controller
 */
import type { ChatBotModelView, IApiClient, UpdateChatBotInput } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { OpError } from './format.ts'
import type { createImStore } from './stores.ts'

/** The snapshot poll cadence while the section is on screen, in milliseconds. */
export const POLL_MS = 3000

/** The mounted `chatBots` Remote namespace, typed from the host's generated contract. */
export type ChatBotsRemote = ClientContext['remote']['chatBots']

/** The bound mutation API of the section's store. */
export type ImBoundActions = BoundActions<ReturnType<typeof createImStore>>

/** What the controller reaches: the Remote, the catalog wire, and the optional native picker. */
export interface ImDeps {
  /** The `ctx.remote.chatBots` namespace. */
  remote: ChatBotsRemote
  /** The wire faces that list models and agent presets. */
  api: Pick<IApiClient, 'llm' | 'agentPresets'>
  /** The Host's native directory picker, when this runtime has one. */
  pickDirectory?: () => Promise<string | null>
}

/** The business face the section component receives. */
export interface ImInjected {
  /** Snapshot poll cadence in milliseconds. */
  pollMs: number
  /** Read the manager snapshot now. */
  refresh: () => Promise<void>
  /** Read the model and preset catalogs the bot cards offer. */
  loadCatalog: () => Promise<void>
  /** Connect a bot from the open form; keeps the form open with the failure on refusal. */
  connect: (platform: string, alias: string, values: Record<string, string>) => Promise<void>
  /** Rename a bot. */
  rename: (id: string, alias: string) => Promise<void>
  /** Enable or disable a bot. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  /** Probe a bot's platform connection once. */
  check: (id: string) => Promise<void>
  /** Restart a bot's connection. */
  retry: (id: string) => Promise<void>
  /** Disconnect and delete a bot. */
  remove: (id: string) => Promise<void>
  /** Set a bot's workspace directory; null follows the host default. */
  setWorkspace: (id: string, workspace: string | null) => Promise<void>
  /** Pick a directory with the native chooser and apply it; absent without a native picker. */
  pickWorkspace?: (id: string) => Promise<void>
  /** Set a bot's model route and effort; null follows the host default. */
  setModel: (id: string, model: ChatBotModelView | null) => Promise<void>
  /** Set a bot's agent preset; null follows the host default. */
  setPreset: (id: string, agentProfile: string | null) => Promise<void>
  /** Mint a one-time pairing code. */
  issueCode: () => Promise<void>
  /** Revoke a paired account. */
  unpair: (key: string) => Promise<void>
}

/**
 * The business code of a failed call. The host reports every `chatBots`
 * failure under its registered `chat-bot-failed` wire code and carries the
 * business reason in `details.reason`; any other failure keeps its own code.
 */
function failureCode(failure: { code: string; details: object }): string {
  const { reason } = failure.details as { reason?: unknown }
  return failure.code === 'chat-bot-failed' && typeof reason === 'string' ? reason : failure.code
}

/** A settled call: the value, or the failure folded to `{code, message}`. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: OpError }

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Settle a Remote call. The generated face folds carrier failures into the
 * error branch; only assembly faults still reject, and those fold into an
 * `unavailable` failure so a poll tick never leaks a rejection.
 * @param run - the call.
 * @returns the value or the folded failure.
 */
async function settle<T>(run: () => Promise<RemoteResult<T>>): Promise<Outcome<T>> {
  try {
    const result = await run()
    return result.ok ? result : { ok: false, error: { code: failureCode(result.error), message: result.error.message } }
  } catch (error) {
    return { ok: false, error: { code: 'unavailable', message: messageOf(error) } }
  }
}

/**
 * Build the section's operation face.
 * @param deps - the Remote, catalog wire, and optional native picker.
 * @param actions - the bound mutation API of the section store.
 * @returns the inject face.
 */
export function createImController(deps: ImDeps, actions: ImBoundActions): ImInjected {
  const { remote, api, pickDirectory } = deps
  let latest = 0

  const refresh = async (): Promise<void> => {
    const mine = ++latest
    const outcome = await settle(() => remote.snapshot())
    // A newer read has begun since: its answer, not this one, is current.
    if (mine !== latest) return
    if (outcome.ok) actions.snapshotLoaded(outcome.value)
    else actions.snapshotFailed(outcome.error)
  }

  const busyWhile = async (op: string, run: () => Promise<void>): Promise<void> => {
    actions.setBusy(op, true)
    try {
      await run()
    } finally {
      actions.setBusy(op, false)
    }
  }

  const update = (id: string, patch: Omit<UpdateChatBotInput, 'id'>): Promise<void> => busyWhile(`${id}:update`, async () => {
    actions.setNote(id, null)
    const outcome = await settle(() => remote.updateBot({ id, ...patch }))
    if (!outcome.ok) actions.setNote(id, { kind: 'error', error: outcome.error })
    await refresh()
  })

  const loadModels = async (): Promise<void> => {
    try {
      const { result } = await api.llm.models({})
      if (result.ok) actions.modelsLoaded(result.value.groups)
      else actions.modelsFailed()
    } catch {
      // The wire rejected rather than answered; the cards fall back to the current setting.
      actions.modelsFailed()
    }
  }

  const loadPresets = async (): Promise<void> => {
    try {
      const { result } = await api.agentPresets.list({})
      if (result.ok) {
        actions.presetsLoaded(result.value.presets
          .filter(preset => preset.broken === undefined)
          .map(preset => preset.name === undefined ? { id: preset.id } : { id: preset.id, name: preset.name }))
      } else {
        actions.presetsFailed()
      }
    } catch {
      // The wire rejected rather than answered; the cards fall back to the current setting.
      actions.presetsFailed()
    }
  }

  const setWorkspace = (id: string, workspace: string | null): Promise<void> => update(id, { settings: { workspace } })

  return {
    pollMs: POLL_MS,
    refresh,
    loadCatalog: async () => { await Promise.all([loadModels(), loadPresets()]) },
    connect: async (platform, alias, values) => {
      actions.formPending()
      const name = alias.trim()
      const outcome = await settle(() => remote.addBot(name === '' ? { platform, values } : { platform, alias: name, values }))
      if (!outcome.ok) {
        actions.formFailed(outcome.error)
        return
      }
      actions.closeForm()
      actions.select(platform)
      actions.setExpanded(outcome.value.id, true)
      await refresh()
    },
    rename: (id, alias) => update(id, { alias }),
    setEnabled: (id, enabled) => update(id, { enabled }),
    check: id => busyWhile(`${id}:check`, async () => {
      actions.setNote(id, null)
      const outcome = await settle(() => remote.checkBot({ id }))
      actions.setNote(id, outcome.ok
        ? {
          kind: 'check',
          ok: outcome.value.ok,
          ...outcome.value.message === undefined ? {} : { message: outcome.value.message },
          checkedAt: outcome.value.checkedAt,
        }
        : { kind: 'error', error: outcome.error })
      await refresh()
    }),
    retry: id => busyWhile(`${id}:retry`, async () => {
      actions.setNote(id, null)
      const outcome = await settle(() => remote.retryBot({ id }))
      if (!outcome.ok) actions.setNote(id, { kind: 'error', error: outcome.error })
      await refresh()
    }),
    remove: id => busyWhile(`${id}:remove`, async () => {
      const outcome = await settle(() => remote.removeBot({ id }))
      actions.askRemove(null)
      if (!outcome.ok) actions.setNote(id, { kind: 'error', error: outcome.error })
      await refresh()
    }),
    setWorkspace,
    ...pickDirectory === undefined
      ? {}
      : {
        pickWorkspace: async (id: string): Promise<void> => {
          try {
            const picked = await pickDirectory()
            if (picked !== null) await setWorkspace(id, picked)
          } catch (error) {
            actions.setNote(id, { kind: 'error', error: { code: 'pick-failed', message: messageOf(error) } })
          }
        },
      },
    setModel: (id, model) => update(id, { settings: { model } }),
    setPreset: (id, agentProfile) => update(id, { settings: { agentProfile } }),
    issueCode: () => busyWhile('code', async () => {
      const outcome = await settle(() => remote.issueOwnerCode())
      if (outcome.ok) actions.codeIssued({ value: outcome.value.code, expiresAt: outcome.value.expiresAt })
      else actions.ownerFailed(outcome.error)
    }),
    unpair: key => busyWhile(`owner:${key}`, async () => {
      const outcome = await settle(() => remote.unpairOwner({ key }))
      if (!outcome.ok) actions.ownerFailed(outcome.error)
      await refresh()
    }),
  }
}
