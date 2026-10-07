/**
 * The DOM-free editor controller: the draft account's write machine. It owns
 * the editable open, the manual save's CAS lifecycle (never routed through
 * any request fence, so a Workspace switch cannot abort it), the
 * file-level-watch external-change detection with own-save echo suppression,
 * and the conflict settlement (reload / overwrite). Results write back
 * through the draft store keyed by the machine/workspace/path that initiated
 * them, so a late settlement after a placement switch or machine
 * re-registration lands on the originating entry or nowhere — never on
 * another document.
 * @module ui-workspace-editor/controller
 */
import type { SnapshotStore, WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WorkspaceFileOpenResult, WorkspaceFileSaveResult, WorkspaceFileStatResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { editorEntry, editorKey } from './stores.ts'
import type { WorkspaceEditorDraftEntry, WorkspaceEditorState } from './stores.ts'

/** Wire calls the controller drives; bound in apply over the typed Remote. */
export interface WorkspaceEditorWire {
  /** Full editable open through the workspace-file-write Remote. */
  open(workspaceId: string, path: string, signal: AbortSignal): Promise<RemoteResult<WorkspaceFileOpenResult>>
  /** Authoritative version probe (the only version format comparable with base versions). */
  stat(workspaceId: string, path: string, signal: AbortSignal): Promise<RemoteResult<WorkspaceFileStatResult>>
  /** Version-checked save. */
  save(
    workspaceId: string,
    path: string,
    request: { content: string; baseVersion: string; saveId: string },
    signal: AbortSignal,
  ): Promise<RemoteResult<WorkspaceFileSaveResult>>
  /** Optional file-level watch; absent disables external-change detection. */
  watchFiles?: (workspaceId: string, path: string, signal: AbortSignal) => AsyncIterable<WorkspaceFileWatchFrame>
}

/** One serialized editor state snapshot (draft text plus JSON history). */
export interface EditorSnapshot {
  readonly draft: string
  readonly history: unknown
}

/** Refcounted watch subscription per watched document. */
interface WatchSeat {
  readonly controller: AbortController
  readonly machine: string
  refs: number
}

/**
 * The editor controller over one draft store.
 */
export class WorkspaceEditorController {
  /** Hard bound on remembered entries per machine; oldest-opened evict first. */
  private static readonly ENTRY_LIMIT = 64

  private readonly watches = new Map<string, WatchSeat>()

  constructor(
    private readonly store: SnapshotStore<WorkspaceEditorState>,
    private readonly wire: WorkspaceEditorWire,
  ) {}

  /**
   * Ensure one document is loaded and watched. Idempotent per key; the
   * watch is refcounted so two simultaneous occupants share one subscription.
   * @param machine - machine partition the entry belongs to.
   * @param workspaceId - owning Workspace.
   * @param path - workspace-relative document path.
   */
  attach(machine: string, workspaceId: string, path: string): void {
    const key = editorKey(workspaceId, path)
    const existing = editorEntry(this.store.getSnapshot(), machine, key)
    if (existing === undefined) {
      this.insert(machine, key, { draft: '', baseVersion: '', eol: 'LF', encoding: 'utf-8', bom: false, status: 'loading' })
      void this.load(machine, workspaceId, path, key)
    }
    this.retainWatch(machine, workspaceId, key)
  }

  /**
   * Release one occupant: serialize the live editor state, then drop the
   * watch refcount and forget a clean entry (dirty drafts stay for their
   * owner's close confirmation to discard).
   * @param machine - machine partition the entry belongs to.
   * @param workspaceId - owning Workspace.
   * @param path - workspace-relative document path.
   * @param snapshot - the unmounting editor's draft and serialized history.
   */
  detach(machine: string, workspaceId: string, path: string, snapshot: EditorSnapshot | undefined): void {
    const key = editorKey(workspaceId, path)
    const existing = editorEntry(this.store.getSnapshot(), machine, key)
    if (snapshot !== undefined && existing !== undefined && existing.status !== 'loading') {
      this.update(machine, key, entry => ({ ...entry, draft: snapshot.draft, history: snapshot.history }))
    }
    this.releaseWatch(key)
    const settled = editorEntry(this.store.getSnapshot(), machine, key)
    if (settled !== undefined && (settled.status === 'clean' || settled.status === 'unavailable')) {
      this.remove(machine, key)
    }
  }

  /**
   * Record that the live editor moved off its saved content. The draft
   * string itself is written at unmount serialization and save snapshots,
   * never per keystroke.
   * @param machine - machine partition the entry belongs to.
   * @param workspaceId - owning Workspace.
   * @param path - workspace-relative document path.
   */
  markDirty(machine: string, workspaceId: string, path: string): void {
    const key = editorKey(workspaceId, path)
    this.update(machine, key, entry => ({
      ...entry,
      status: entry.status === 'clean' || entry.status === 'error' ? 'dirty' : entry.status,
    }))
  }

  /**
   * Save the current draft. The save runs its own lifecycle: no request
   * fence owns it, so a Workspace switch mid-save settles against the
   * originating entry. A second call while one save is in flight is ignored.
   * @param machine - machine partition the entry belongs to.
   * @param workspaceId - owning Workspace.
   * @param path - workspace-relative document path.
   * @param content - the editor's complete current text.
   * @returns resolution after the settlement lands in the draft store.
   */
  async save(machine: string, workspaceId: string, path: string, content: string): Promise<void> {
    const key = editorKey(workspaceId, path)
    const entry = editorEntry(this.store.getSnapshot(), machine, key)
    if (entry === undefined || (entry.status !== 'dirty' && entry.status !== 'error')) return
    await this.commit(machine, workspaceId, path, key, content, entry.baseVersion)
  }

  /**
   * Overwrite the externally-changed file after an explicit conflict
   * confirmation: the CAS premise moves to the conflict's current version.
   * @param machine - machine partition the entry belongs to.
   * @param workspaceId - owning Workspace.
   * @param path - workspace-relative document path.
   * @param content - the editor's complete current text.
   * @returns resolution after the settlement lands in the draft store.
   */
  async confirmOverwrite(machine: string, workspaceId: string, path: string, content: string): Promise<void> {
    const key = editorKey(workspaceId, path)
    const entry = editorEntry(this.store.getSnapshot(), machine, key)
    if (entry === undefined || entry.status !== 'conflict' || entry.conflict === undefined) return
    await this.commit(machine, workspaceId, path, key, content, entry.conflict.currentVersion)
  }

  /**
   * Discard the draft and re-open the document from disk.
   * @param machine - machine partition the entry belongs to.
   * @param workspaceId - owning Workspace.
   * @param path - workspace-relative document path.
   */
  async reload(machine: string, workspaceId: string, path: string): Promise<void> {
    const key = editorKey(workspaceId, path)
    const existing = editorEntry(this.store.getSnapshot(), machine, key)
    if (existing === undefined || existing.status === 'loading') return
    this.update(machine, key, ({ conflict: _conflict, error: _error, ...entry }) => ({ ...entry, status: 'loading' }))
    await this.load(machine, workspaceId, path, key)
  }

  /**
   * React to one watch frame for a watched document: probe the authoritative
   * version and compare it only with the entry's own versions.
   * @param machine - machine partition the entry belongs to.
   * @param workspaceId - owning Workspace.
   * @param path - workspace-relative document path.
   */
  async externalChange(machine: string, workspaceId: string, path: string): Promise<void> {
    const key = editorKey(workspaceId, path)
    const entry = editorEntry(this.store.getSnapshot(), machine, key)
    if (entry === undefined) return
    const probed = await this.wire.stat(workspaceId, path, new AbortController().signal)
    if (!probed.ok) return
    if ('absent' in probed.value) {
      if (entry.status === 'clean') {
        this.update(machine, key, ({ error: _error, ...current }) => ({ ...current, status: 'unavailable' }))
      }
      return
    }
    const version = probed.value.version
    // Own-save echo and a no-op touch both keep the comparable version.
    if (version === entry.savedVersion || version === entry.baseVersion) return
    if (entry.status === 'clean' || entry.status === 'unavailable' || entry.status === 'loading') {
      await this.load(machine, workspaceId, path, key)
      return
    }
    if (entry.status === 'conflict') return
    // Dirty or in-flight: surface the conflict with the disk content for the
    // diff view; an in-flight save settles through its own CAS refusal.
    const disk = await this.wire.open(workspaceId, path, new AbortController().signal)
    this.update(machine, key, ({ error: _error, ...current }) => ({
      ...current,
      status: 'conflict',
      conflict: { currentVersion: version, diskContent: disk.ok ? disk.value.content : null },
    }))
  }

  /** Load (or reload) one entry from the Host. */
  private async load(machine: string, workspaceId: string, path: string, key: string): Promise<void> {
    const result = await this.wire.open(workspaceId, path, new AbortController().signal)
    const current = editorEntry(this.store.getSnapshot(), machine, key)
    if (current === undefined) return
    if (result.ok) {
      this.update(machine, key, () => entryFromOpen(result.value))
      return
    }
    this.update(machine, key, entry => ({ ...entry, status: 'unavailable', error: result.error.message }))
  }

  /** Run one CAS save and settle the outcome into the draft store. */
  private async commit(
    machine: string,
    workspaceId: string,
    path: string,
    key: string,
    content: string,
    baseVersion: string,
  ): Promise<void> {
    const saveId = mintSaveId()
    this.update(machine, key, ({ conflict: _conflict, error: _error, ...entry }) => ({
      ...entry, draft: content, status: 'saving',
    }))
    const result = await this.wire.save(workspaceId, path, { content, baseVersion, saveId }, new AbortController().signal)
    const current = editorEntry(this.store.getSnapshot(), machine, key)
    if (current === undefined) return
    if (result.ok) {
      const { version } = result.value
      this.update(machine, key, ({ conflict: _conflict, error: _error, ...entry }) => ({
        ...entry,
        baseVersion: version,
        savedVersion: version,
        // The settlement marks the saved snapshot clean; a mounted occupant
        // whose live document moved on re-marks the entry dirty.
        status: 'clean',
      }))
      return
    }
    if (result.error.code === 'stale-version') {
      const details = result.error.details as { currentVersion?: string }
      const disk = await this.wire.open(workspaceId, path, new AbortController().signal)
      const currentVersion = details.currentVersion ?? (disk.ok ? disk.value.version : '')
      this.update(machine, key, ({ error: _error, ...entry }) => ({
        ...entry,
        status: 'conflict',
        conflict: { currentVersion, diskContent: disk.ok ? disk.value.content : null },
      }))
      return
    }
    this.update(machine, key, entry => ({ ...entry, status: 'error', error: result.error.message }))
  }

  /** Start or join the file-level watch subscription for one document. */
  private retainWatch(machine: string, workspaceId: string, key: string): void {
    const watch = this.wire.watchFiles
    if (watch === undefined) return
    const seat = this.watches.get(key)
    if (seat !== undefined) {
      seat.refs += 1
      return
    }
    const controller = new AbortController()
    this.watches.set(key, { controller, refs: 1, machine })
    void this.runWatch(workspaceId, key, controller)
  }

  /** Drop one watch reference, ending the subscription at zero. */
  private releaseWatch(key: string): void {
    const seat = this.watches.get(key)
    if (seat === undefined) return
    seat.refs -= 1
    if (seat.refs <= 0) {
      this.watches.delete(key)
      seat.controller.abort()
    }
  }

  /** Consume one file-level watch stream, dispatching change frames to {@link externalChange}. */
  private async runWatch(workspaceId: string, key: string, controller: AbortController): Promise<void> {
    const watch = this.wire.watchFiles
    /* v8 ignore next -- retainWatch already refused the no-watch case; the
       field cannot disappear between the two reads. */
    if (watch === undefined) return
    // The watch key embeds the workspace id and document path; parse them
    // back rather than widening the seat record.
    const separator = key.indexOf('\u0000')
    const path = key.slice(separator + 1)
    try {
      const stream = watch(workspaceId, path, controller.signal)
      for await (const frame of stream) {
        /* v8 ignore next 2 -- a frame already in flight can land between the
           detach that deleted the seat and the abort listener ending this
           stream; the dropped frame is the next attach's reload. */
        const seat = this.watches.get(key)
        if (seat === undefined) return
        if (frame.kind !== 'change') continue
        void this.externalChange(seat.machine, workspaceId, path)
      }
    } catch {
      // A watch stream ending (unsupported, refused, transport loss) only
      // disables external-change detection; manual saves still CAS-guard.
    }
  }

  /** Insert one entry under its machine partition. */
  private insert(machine: string, key: string, entry: WorkspaceEditorDraftEntry): void {
    this.store.update((draft) => {
      const partition = draft.byMachine[machine] ?? {}
      partition[key] = entry
      const keys = Object.keys(partition)
      if (keys.length > WorkspaceEditorController.ENTRY_LIMIT) {
        const evicted = new Set(keys.slice(0, keys.length - WorkspaceEditorController.ENTRY_LIMIT))
        draft.byMachine[machine] = Object.fromEntries(
          Object.entries(partition).filter(([entryKey]) => !evicted.has(entryKey)),
        )
        return
      }
      draft.byMachine[machine] = partition
    })
  }

  /** Mutate one entry under its machine partition. */
  private update(machine: string, key: string, mutate: (entry: WorkspaceEditorDraftEntry) => WorkspaceEditorDraftEntry): void {
    this.store.update((draft) => {
      const partition = draft.byMachine[machine] ?? {}
      const existing = partition[key]
      if (existing === undefined) return
      partition[key] = mutate(existing)
      draft.byMachine[machine] = partition
    })
  }

  /** Remove one entry under its machine partition. */
  private remove(machine: string, key: string): void {
    this.store.update((draft) => {
      const partition = draft.byMachine[machine]
      /* v8 ignore next -- the caller read the entry synchronously one
         statement earlier on the same store, so the partition and key were
         both present; only a concurrent store teardown between those two
         statements could reach the guard. */
      if (partition === undefined || !(key in partition)) return
      const { [key]: _removed, ...rest } = partition
      draft.byMachine[machine] = rest
    })
  }
}

/**
 * Mint a Host-acceptable save id (`^[\w-]{1,128}$`).
 * @returns a fresh `save-` prefixed id, unique per call.
 */
export function mintSaveId(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `save-${uuid}`
}

/** Build a clean entry from one editable open result. */
function entryFromOpen(result: WorkspaceFileOpenResult): WorkspaceEditorDraftEntry {
  return {
    draft: result.content,
    baseVersion: result.version,
    eol: result.eol,
    encoding: result.encoding,
    bom: result.bom,
    status: 'clean',
  }
}
