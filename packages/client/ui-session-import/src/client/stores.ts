/**
 * Shared viewing and interaction state of the two session-import surfaces:
 * the settings section (the latest scan of the serving machine, the
 * selection, the target, the last import results) and the archive dock (the
 * agent-preset roster and per-archive continuation progress). The module
 * exports the factories only (a module-level handle would pin the store
 * identity across plugin reloads).
 * @module @deepseek-ai/dsh-client-ui-session-import/stores
 */
import type {
  OfficialImportResult, OfficialSessionScan, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Where the next import lands: the source's own working directory, or one workspace id. */
export type TargetChoice = { kind: 'source-cwd' } | { kind: 'workspace'; workspaceId: string }

/** Settings section state. */
export interface SessionImportState {
  /** Phase of the latest scan; a later failure keeps `ready` and the last scan. */
  phase: 'idle' | 'scanning' | 'ready' | 'error'
  /** Latest scan of the serving machine; null until one lands. */
  scan: OfficialSessionScan | null
  /** Failure of the latest scan, cleared by the next success. */
  scanError: string | null
  /** Selected candidate source ids. */
  selected: string[]
  /** Where the next import lands. */
  target: TargetChoice
  /** Whether an import batch or upload is in flight. */
  importing: boolean
  /** Outcomes of the latest batch, with the row label each was requested under. */
  results: Array<OfficialImportResult & { label: string }>
  /** The latest refusal raised before the Host answered (an oversized or unreadable upload, an archive not listed yet). */
  uploadError: string | null
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
export type SessionImportActions = {
  reset: (draft: SessionImportState) => void
  scanStarted: (draft: SessionImportState) => void
  scanLoaded: (draft: SessionImportState, scan: OfficialSessionScan) => void
  scanFailed: (draft: SessionImportState, message: string) => void
  toggle: (draft: SessionImportState, sourceId: string) => void
  setSelected: (draft: SessionImportState, sourceIds: string[]) => void
  setTarget: (draft: SessionImportState, target: TargetChoice) => void
  importStarted: (draft: SessionImportState) => void
  importSettled: (draft: SessionImportState, results: Array<OfficialImportResult & { label: string }>) => void
  refuse: (draft: SessionImportState, message: string) => void
}

function initialImportState(): SessionImportState {
  return {
    phase: 'idle',
    scan: null,
    scanError: null,
    selected: [],
    target: { kind: 'source-cwd' },
    importing: false,
    results: [],
    uploadError: null,
  }
}

/**
 * Create the settings section store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createSessionImportStore(): EngineStoreHandle<SessionImportState, SessionImportActions> {
  return defineStore({
    init: initialImportState,
    actions: {
      reset: (d) => { Object.assign(d, initialImportState()) },
      scanStarted: (d) => {
        d.phase = d.scan === null ? 'scanning' : 'ready'
        d.scanError = null
      },
      scanLoaded: (d, scan: OfficialSessionScan) => {
        d.scan = scan
        d.phase = 'ready'
        d.scanError = null
        // A selection never outlives the candidate it names.
        d.selected = d.selected.filter(id => scan.items.some(item => item.sourceId === id))
      },
      scanFailed: (d, message: string) => {
        d.scanError = message
        if (d.scan === null) d.phase = 'error'
      },
      toggle: (d, sourceId: string) => {
        d.selected = d.selected.includes(sourceId)
          ? d.selected.filter(id => id !== sourceId)
          : [...d.selected, sourceId]
      },
      setSelected: (d, sourceIds: string[]) => { d.selected = [...sourceIds] },
      setTarget: (d, target: TargetChoice) => { d.target = target },
      importStarted: (d) => {
        d.importing = true
        d.uploadError = null
      },
      importSettled: (d, results: Array<OfficialImportResult & { label: string }>) => {
        d.importing = false
        d.results = results
        const settled = new Set(results.filter(result => result.outcome.status !== 'failed').map(result => result.source))
        d.selected = d.selected.filter(id => !settled.has(id))
      },
      refuse: (d, message: string) => {
        d.importing = false
        d.uploadError = message
      },
    },
  })
}

/** One selectable agent preset. */
export interface PresetOption {
  /** Preset id passed as the continuation's `agentProfile`. */
  id: string
  /** Display name the preset published, when it published one. */
  name?: string
}

/** Archive dock state, shared across archives. */
export interface ArchiveDockState {
  /** The agent-preset roster the dock offers. */
  presets: { status: 'idle' | 'loading' | 'ready' | 'error'; options: PresetOption[] }
  /** Archives whose continuation is being created. */
  pending: SessionId[]
  /** Latest continuation failure per archive. */
  errors: Record<string, string>
}

/** Annotation twin of the dock actions literal below. */
export type ArchiveDockActions = {
  presetsLoading: (draft: ArchiveDockState) => void
  presetsLoaded: (draft: ArchiveDockState, options: PresetOption[]) => void
  presetsFailed: (draft: ArchiveDockState) => void
  continueStarted: (draft: ArchiveDockState, sessionId: SessionId) => void
  continueFailed: (draft: ArchiveDockState, sessionId: SessionId, message: string) => void
  continueSettled: (draft: ArchiveDockState, sessionId: SessionId) => void
}

/**
 * Create the archive dock store handle.
 * @returns the store handle.
 */
export function createArchiveDockStore(): EngineStoreHandle<ArchiveDockState, ArchiveDockActions> {
  return defineStore({
    init: (): ArchiveDockState => ({ presets: { status: 'idle', options: [] }, pending: [], errors: {} }),
    actions: {
      presetsLoading: (d) => { d.presets.status = 'loading' },
      presetsLoaded: (d, options: PresetOption[]) => { d.presets = { status: 'ready', options } },
      presetsFailed: (d) => { d.presets.status = 'error' },
      continueStarted: (d, sessionId: SessionId) => {
        d.pending = [...d.pending.filter(id => id !== sessionId), sessionId]
        d.errors = Object.fromEntries(Object.entries(d.errors).filter(([id]) => id !== sessionId))
      },
      continueFailed: (d, sessionId: SessionId, message: string) => {
        d.pending = d.pending.filter(id => id !== sessionId)
        d.errors[sessionId] = message
      },
      continueSettled: (d, sessionId: SessionId) => {
        d.pending = d.pending.filter(id => id !== sessionId)
      },
    },
  })
}
