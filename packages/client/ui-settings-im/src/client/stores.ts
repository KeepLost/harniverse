/**
 * The IM settings section's shared viewing and interaction state: the latest
 * host snapshot (its poll is owned by the section), the selected channel,
 * expanded cards, the connect form, pending operations, per-bot notes, the
 * one-time pairing code, and the model/preset catalogs the bot cards offer.
 * The module exports the factory only (a module-level handle would pin the
 * store identity across plugin reloads).
 * @module @deepseek-ai/dsh-client-ui-settings-im/stores
 */
import type { ChatBotsSnapshot, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { OpError } from './format.ts'

/** The connect form of one platform; absent while closed. */
export interface ConnectForm {
  /** Platform the form connects a bot to. */
  platform: string
  /** Optional alias being typed. */
  alias: string
  /** Field values being typed, by descriptor field key. */
  values: Record<string, string>
  /** Whether the connect attempt is in flight. */
  pending: boolean
  /** Failure of the last attempt, cleared by the next edit. */
  error: OpError | null
}

/** Outcome shown inside one bot card. */
export type BotNote =
  | { kind: 'check'; ok: boolean; message?: string; checkedAt: number }
  | { kind: 'error'; error: OpError }

/** One selectable agent preset. */
export interface PresetOption {
  /** Preset id written to the bot's `agentProfile`. */
  id: string
  /** Display name the preset published, when it published one. */
  name?: string
}

/** IM section state. */
export interface ImState {
  /** Latest host snapshot; null until the first read lands. */
  snapshot: ChatBotsSnapshot | null
  /** Phase of the snapshot read; a later failure keeps `ready` and the last snapshot. */
  phase: 'loading' | 'ready' | 'error'
  /** Failure of the latest snapshot read, cleared by the next success. */
  loadError: OpError | null
  /** Selected channel's platform id; null follows the first platform. */
  selected: string | null
  /** Bot ids whose cards are expanded. */
  expanded: string[]
  /** The open connect form, or null. */
  form: ConnectForm | null
  /** Pending operations as `<botId>:<op>`, `owner:<key>`, or `code`. */
  busy: string[]
  /** Latest operation outcome per bot id. */
  notes: Record<string, BotNote>
  /** Bot id awaiting removal confirmation. */
  confirmRemove: string | null
  /** The issued one-time pairing code. */
  code: { value: string; expiresAt: number } | null
  /** Failure of the last pairing-code or unpair operation. */
  ownerError: OpError | null
  /** Provider groups the model selects offer. */
  models: { status: 'idle' | 'ready' | 'error'; groups: ModelProviderGroup[] }
  /** Agent presets the preset select offers. */
  presets: { status: 'idle' | 'ready' | 'error'; options: PresetOption[] }
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
export type ImActions = {
  snapshotLoaded: (draft: ImState, snapshot: ChatBotsSnapshot) => void
  snapshotFailed: (draft: ImState, error: OpError) => void
  select: (draft: ImState, platform: string) => void
  setExpanded: (draft: ImState, id: string, expanded: boolean) => void
  openForm: (draft: ImState, platform: string) => void
  closeForm: (draft: ImState) => void
  setFormValue: (draft: ImState, key: string, value: string) => void
  setFormAlias: (draft: ImState, alias: string) => void
  formPending: (draft: ImState) => void
  formFailed: (draft: ImState, error: OpError) => void
  setBusy: (draft: ImState, op: string, busy: boolean) => void
  setNote: (draft: ImState, id: string, note: BotNote | null) => void
  askRemove: (draft: ImState, id: string | null) => void
  codeIssued: (draft: ImState, code: { value: string; expiresAt: number }) => void
  clearCode: (draft: ImState) => void
  ownerFailed: (draft: ImState, error: OpError) => void
  modelsLoaded: (draft: ImState, groups: ModelProviderGroup[]) => void
  modelsFailed: (draft: ImState) => void
  presetsLoaded: (draft: ImState, options: PresetOption[]) => void
  presetsFailed: (draft: ImState) => void
}

/**
 * Create the IM section store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createImStore(): EngineStoreHandle<ImState, ImActions> {
  return defineStore({
    init: (): ImState => ({
      snapshot: null,
      phase: 'loading',
      loadError: null,
      selected: null,
      expanded: [],
      form: null,
      busy: [],
      notes: {},
      confirmRemove: null,
      code: null,
      ownerError: null,
      models: { status: 'idle', groups: [] },
      presets: { status: 'idle', options: [] },
    }),
    actions: {
      snapshotLoaded: (d, snapshot: ChatBotsSnapshot) => {
        d.snapshot = snapshot
        d.phase = 'ready'
        d.loadError = null
      },
      snapshotFailed: (d, error: OpError) => {
        d.loadError = error
        if (d.snapshot === null) d.phase = 'error'
      },
      select: (d, platform: string) => { d.selected = platform },
      setExpanded: (d, id: string, expanded: boolean) => {
        const rest = d.expanded.filter(entry => entry !== id)
        d.expanded = expanded ? [...rest, id] : rest
      },
      openForm: (d, platform: string) => {
        d.form = { platform, alias: '', values: {}, pending: false, error: null }
      },
      closeForm: (d) => { d.form = null },
      setFormValue: (d, key: string, value: string) => {
        if (d.form === null) return
        d.form.values[key] = value
        d.form.error = null
      },
      setFormAlias: (d, alias: string) => {
        if (d.form === null) return
        d.form.alias = alias
        d.form.error = null
      },
      formPending: (d) => {
        if (d.form === null) return
        d.form.pending = true
        d.form.error = null
      },
      formFailed: (d, error: OpError) => {
        if (d.form === null) return
        d.form.pending = false
        d.form.error = error
      },
      setBusy: (d, op: string, busy: boolean) => {
        const rest = d.busy.filter(entry => entry !== op)
        d.busy = busy ? [...rest, op] : rest
      },
      setNote: (d, id: string, note: BotNote | null) => {
        if (note === null) d.notes = Object.fromEntries(Object.entries(d.notes).filter(([key]) => key !== id))
        else d.notes[id] = note
      },
      askRemove: (d, id: string | null) => { d.confirmRemove = id },
      codeIssued: (d, code: { value: string; expiresAt: number }) => {
        d.code = code
        d.ownerError = null
      },
      clearCode: (d) => { d.code = null },
      ownerFailed: (d, error: OpError) => { d.ownerError = error },
      modelsLoaded: (d, groups: ModelProviderGroup[]) => { d.models = { status: 'ready', groups } },
      modelsFailed: (d) => { d.models.status = 'error' },
      presetsLoaded: (d, options: PresetOption[]) => { d.presets = { status: 'ready', options } },
      presetsFailed: (d) => { d.presets.status = 'error' },
    },
  })
}
