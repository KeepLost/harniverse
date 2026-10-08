/**
 * The editor plugin's draft account: one JSON-compatible entry per
 * machine/workspace/path, holding the LF draft, its base version, the
 * decode facts a save must reproduce, the editor status machine state, and
 * the serialized CodeMirror history. Entries survive overlay↔drawer
 * placement switches and machine re-registrations because the store lives
 * in the plugin's apply closure, never in a component or a registration
 * store seat. File content deliberately never enters browser persistence.
 * @module ui-workspace-editor/stores
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Lifecycle of one editable document entry. */
export type WorkspaceEditorStatus =
  | 'loading'
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'conflict'
  | 'error'
  /** The Host refused the editable open (mixed EOL, undecodable, …): read-only fallback. */
  | 'unavailable'

/** One draft entry; every member is JSON-compatible data. */
export interface WorkspaceEditorDraftEntry {
  /** Current LF-normalized draft text (updated on unmount serialization and save snapshots). */
  readonly draft: string
  /** `FsVersion` the draft was based on. */
  readonly baseVersion: string
  /** Line-ending style the Host reported at open; a save restores it. */
  readonly eol: 'LF' | 'CRLF'
  /** Canonical encoding name the file decoded with. */
  readonly encoding: string
  /** Whether the file's bytes began with a byte order mark. */
  readonly bom: boolean
  /** Editor status; drives the dirty marker, save button, and conflict bar. */
  readonly status: WorkspaceEditorStatus
  /** Present while the base version lost the CAS race. */
  readonly conflict?: { readonly currentVersion: string; readonly diskContent: string | null }
  /** Last failure text for `status: 'error'` / `status: 'unavailable'`. */
  readonly error?: string
  /** Serialized `EditorState.toJSON({ history })` payload for undo restoration. */
  readonly history?: unknown
  /** Version of this entry's own last committed save (watch-echo detection). */
  readonly savedVersion?: string
}

/** Draft entries keyed by `${workspaceId}\u0000${path}`, partitioned by machine key. */
export interface WorkspaceEditorState {
  byMachine: Record<string, Record<string, WorkspaceEditorDraftEntry>>
}

/**
 * Build the draft key for one workspace-relative path.
 * @param workspaceId - workspace that owns the file.
 * @param path - workspace-relative file path.
 * @returns the key under which the file's draft entry is stored.
 */
export function editorKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`
}

/**
 * Create the editor draft store. The factory is module-level currency; the
 * one live instance is created in the plugin's apply and shared by both
 * preview-document registrations.
 * @returns the draft-account snapshot store.
 */
export function createWorkspaceEditorStore(): SnapshotStore<WorkspaceEditorState> {
  return createSnapshotStore<WorkspaceEditorState>({ byMachine: {} })
}

/**
 * Read one machine's entry partition.
 * @param state - current draft-account snapshot.
 * @param machine - machine key that partitions the entries.
 * @returns the partition's entries, or an empty record when the machine has none.
 */
export function editorPartition(state: WorkspaceEditorState, machine: string): Record<string, WorkspaceEditorDraftEntry> {
  return state.byMachine[machine] ?? {}
}

/**
 * Read one draft entry.
 * @param state - current draft-account snapshot.
 * @param machine - machine key that partitions the entries.
 * @param key - draft key from {@link editorKey}.
 * @returns the entry, or `undefined` when none exists for the key.
 */
export function editorEntry(state: WorkspaceEditorState, machine: string, key: string): WorkspaceEditorDraftEntry | undefined {
  return editorPartition(state, machine)[key]
}
