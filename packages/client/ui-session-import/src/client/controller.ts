/**
 * The operation layers of the session-import surfaces. The section
 * controller drives the `officialSessionImport` Remote on the targeted
 * machine and opens imported archives once the session list carries them;
 * the dock controller lists agent presets, continues an archive into a new
 * session, and keeps each archive's composer inert. Both publish outcomes
 * through their store's bound actions and hold no state of their own;
 * components receive their verbs as plain callbacks through the inject face.
 * @module @deepseek-ai/dsh-client-ui-session-import/controller
 */
import type {
  IApiClient, MachineTargetSource, OfficialImportResult, OfficialImportTarget, SessionId, WorkspaceId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { formatBytes, toBase64 } from './format.ts'
import type { createArchiveDockStore, createSessionImportStore, PresetOption, TargetChoice } from './stores.ts'

/** How long an open waits for a just-imported archive to reach the session list. */
export const OPEN_WAIT_MS = 5000

/** Upload ceiling assumed before the first scan reports the machine's own. */
export const DEFAULT_UPLOAD_LIMIT_BYTES = 64 * 1024 * 1024

/** The mounted `officialSessionImport` Remote namespace, typed from the host's generated contract. */
export type OfficialSessionImportRemote = ClientContext['remote']['officialSessionImport']

/** The bound mutation API of the section store. */
export type SessionImportBoundActions = BoundActions<ReturnType<typeof createSessionImportStore>>

/** The bound mutation API of the dock store. */
export type ArchiveDockBoundActions = BoundActions<ReturnType<typeof createArchiveDockStore>>

/** The section's business face. */
export interface SessionImportInjected {
  /** The targeted machine, so the section rescans after a switch. */
  hooks: { machine: MachineTargetSource }
  /** Scan the targeted machine now. */
  scan: () => Promise<void>
  /** Import the given candidates into the chosen target, then rescan. */
  importSelected: (sourceIds: string[], target: TargetChoice, labels: Record<string, string>) => Promise<void>
  /** Import one uploaded official log into the chosen target, then rescan. */
  importFile: (file: File, target: TargetChoice, limitBytes: number) => Promise<void>
  /**
   * Open one archive once the session list carries it.
   * @returns whether the archive was opened.
   */
  openSession: (sessionId: string) => Promise<boolean>
}

/** The dock's business face, bound to one session. */
export interface ArchiveDockInjected {
  /** Read the agent-preset roster the continuation may run. */
  loadPresets: () => Promise<void>
  /** Continue this archive in a new session under a preset (empty: the default), then open it. */
  continueArchive: (agentProfile: string) => Promise<void>
}

function wireTarget(target: TargetChoice): OfficialImportTarget {
  return target.kind === 'source-cwd'
    ? { kind: 'source-cwd' }
    : { kind: 'workspace', workspaceId: target.workspaceId as WorkspaceId }
}

/**
 * Resolve once the list carries the session, or after the wait elapses.
 * @param sessions - the session list face.
 * @param sessionId - the session to wait for.
 * @returns whether the list carries the session.
 */
async function listed(sessions: Pick<ISessions, 'list'>, sessionId: string): Promise<boolean> {
  const present = () => sessions.list.getSnapshot().byId[sessionId as SessionId] !== undefined
  if (present()) return true
  await new Promise<void>((resolve) => {
    const settle = () => {
      clearTimeout(timer)
      stop()
      resolve()
    }
    const timer = setTimeout(settle, OPEN_WAIT_MS)
    const stop = sessions.list.subscribe(() => { if (present()) settle() })
  })
  return present()
}

/** What the section controller reaches. */
export interface SessionImportDeps {
  readonly remote: OfficialSessionImportRemote
  readonly sessions: Pick<ISessions, 'list' | 'open'>
  readonly machine: MachineTargetSource
  /** Localized copy for refusals raised before the Host answers. */
  readonly copy: {
    tooLarge: (size: string, limit: string) => string
    readError: (message: string) => string
  }
}

/**
 * Build the section's operation face over its bound store actions.
 * @param deps - the Remote, the session list, the machine source, and refusal copy.
 * @param actions - the section store's bound actions.
 * @returns the inject face.
 */
export function createSessionImportController(deps: SessionImportDeps, actions: SessionImportBoundActions): SessionImportInjected {
  const { remote, sessions, copy } = deps
  let generation = 0
  const scan = async (): Promise<void> => {
    const current = ++generation
    actions.scanStarted()
    const result = await remote.scan()
    // A newer scan (a rescan or a machine switch) supersedes this one.
    if (current !== generation) return
    if (result.ok) actions.scanLoaded(result.value)
    else actions.scanFailed(result.error.message)
  }
  const settle = async (results: Array<OfficialImportResult & { label: string }>): Promise<void> => {
    actions.importSettled(results)
    await scan()
  }
  const failed = (source: string, message: string): OfficialImportResult & { label: string } =>
    ({ source, label: source, outcome: { status: 'failed', reason: 'failed', message } })
  return {
    hooks: { machine: deps.machine },
    scan,
    async importSelected(sourceIds, target, labels) {
      actions.importStarted()
      const result = await remote.importSources(sourceIds, wireTarget(target))
      await settle(result.ok
        ? result.value.map(entry => ({ ...entry, label: labels[entry.source] ?? entry.source }))
        : sourceIds.map(id => ({ ...failed(id, result.error.message), label: labels[id] ?? id })))
    },
    async importFile(file, target, limitBytes) {
      if (file.size > limitBytes) {
        actions.refuse(copy.tooLarge(formatBytes(file.size), formatBytes(limitBytes)))
        return
      }
      actions.importStarted()
      let content: string
      try {
        content = toBase64(new Uint8Array(await file.arrayBuffer()))
      } catch (error) {
        actions.refuse(copy.readError(error instanceof Error ? error.message : String(error)))
        return
      }
      const result = await remote.importUpload(file.name, content, wireTarget(target))
      await settle([result.ok
        ? { ...result.value, label: file.name }
        : failed(file.name, result.error.message)])
    },
    async openSession(sessionId) {
      if (!await listed(sessions, sessionId)) return false
      sessions.open(sessionId as SessionId)
      return true
    },
  }
}

/** What the dock controller reaches. */
export interface ArchiveDockDeps {
  readonly api: Pick<IApiClient, 'agentPresets'>
  readonly sessions: Pick<ISessions, 'continueArchive' | 'open'>
}

/**
 * Build one archive's dock face over the dock store's bound actions.
 * @param deps - the preset roster wire and the sessions face.
 * @param sessionId - the archive the dock renders for.
 * @param actions - the dock store's bound actions.
 * @returns the inject face.
 */
export function createArchiveDockController(
  deps: ArchiveDockDeps,
  sessionId: SessionId,
  actions: ArchiveDockBoundActions,
): ArchiveDockInjected {
  return {
    async loadPresets() {
      actions.presetsLoading()
      try {
        const { result } = await deps.api.agentPresets.list({})
        if (!result.ok) {
          actions.presetsFailed()
          return
        }
        actions.presetsLoaded(result.value.presets
          .filter(preset => preset.broken === undefined)
          .map((preset): PresetOption => preset.name === undefined ? { id: preset.id } : { id: preset.id, name: preset.name }))
      } catch {
        // The wire rejected rather than answered; the default preset stays available.
        actions.presetsFailed()
      }
    },
    async continueArchive(agentProfile) {
      actions.continueStarted(sessionId)
      try {
        const child = await deps.sessions.continueArchive({
          sessionId,
          ...agentProfile === '' ? {} : { agentProfile },
        })
        actions.continueSettled(sessionId)
        deps.sessions.open(child)
      } catch (error) {
        actions.continueFailed(sessionId, error instanceof Error ? error.message : String(error))
      }
    },
  }
}
