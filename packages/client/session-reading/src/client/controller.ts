/**
 * Browser-side object layer of the session-reading capability. It mirrors the
 * Host ledger through `sessionReading.list`, acknowledges a completed turn only
 * once the reader demonstrably saw it, and carries manual marks. React-free:
 * the plugin publishes it as the `useSessionReading` root source.
 * @module @deepseek-ai/dsh-client-session-reading/client/controller
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  SessionReadingAction,
  SessionReadingListValue,
  SessionReadingMarkValue,
  SessionReadingRecord,
} from '../types.ts'

/** Unread marker of one row as the session list renders it. */
export interface SessionReadingUnread {
  /** The latest completed turn ended with an error. */
  readonly failed: boolean
}

/** Unread rows keyed by session id; an absent key is a read or unknown session. */
export type SessionReadingUnreadRows = Readonly<Record<SessionId, SessionReadingUnread>>

/** Snapshot behind the `useSessionReading` root hook. */
export interface SessionReadingState {
  readonly unread: SessionReadingUnreadRows
  /** Apply a reader mark by hand. */
  readonly mark: (sessionId: SessionId, action: SessionReadingAction) => void
  /** Report whether the session list currently renders one session's row. */
  readonly report: (sessionId: SessionId, rowVisible: boolean) => void
}

/** The sessions-service reads this controller needs. */
export interface ReadingSessions {
  /** Current selection feed. */
  readonly list: HostObservable<Pick<SessionListState, 'current'>>
  /**
   * Resolve the transcript source of one session.
   * @param sessionId - selected session.
   * @returns its conversation snapshot source, or absence while it has no binding.
   */
  binding(sessionId: SessionId): {
    readonly session: HostObservable<Pick<ConversationSnapshot, 'turnEnds' | 'openState'>>
  } | undefined
}

/** Page attention the controller cannot observe by itself. */
export interface ReadingPage {
  /** Whether the document is visible and holds the window focus. */
  focused(): boolean
  /**
   * Observe focus and visibility changes.
   * @param listener - called after either fact may have moved.
   * @returns the unsubscribe function.
   */
  onFocusedChange(listener: () => void): () => void
}

/** The two Remote calls this controller makes. */
export interface SessionReadingRemote {
  list(): Promise<RemoteResult<SessionReadingListValue>>
  mark(sessionId: SessionId, action: SessionReadingAction): Promise<RemoteResult<SessionReadingMarkValue>>
}

/** Describe a failed call for the log without trusting it to be an Error. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a record still asks for the reader's attention. */
function isUnread(record: SessionReadingRecord): boolean {
  return record.manualUnread || record.completedTurn > record.readTurn
}

/**
 * Whether the transcript demonstrably shows what the ledger credits the
 * session with: the latest completed turn sits in the window, or — for a
 * session that completed no turn since the Host started — its window finished
 * loading whatever it holds.
 */
function showsLedgerTurn(transcript: Pick<ConversationSnapshot, 'turnEnds' | 'openState'>, record: SessionReadingRecord): boolean {
  return record.completedTurn > 0 ? transcript.turnEnds.has(record.completedTurn) : transcript.openState === 'open'
}

/** Whether two unread row sets carry the same sessions with the same failure bits. */
function sameRows(left: SessionReadingUnreadRows, right: SessionReadingUnreadRows): boolean {
  const keys = Object.keys(left) as SessionId[]
  return keys.length === Object.keys(right).length
    && keys.every(key => right[key]?.failed === left[key]?.failed)
}

const NO_ROWS: SessionReadingUnreadRows = Object.freeze(Object.create(null) as SessionReadingUnreadRows)

/** Ledger mirror, attention-gated acknowledgement, and manual marks for one page. */
export class SessionReadingController implements HostObservable<SessionReadingState> {
  private records = new Map<SessionId, SessionReadingRecord>()
  private readonly listeners = new Set<() => void>()
  /** Sessions this page flagged unread while they stayed selected; they are acknowledged only after the selection leaves them. */
  private readonly held = new Set<SessionId>()
  /** Sessions whose acknowledgement landed and whose ledger refetch is still owed. */
  private readonly acknowledging = new Set<SessionId>()
  private readonly unsubscribers: Array<() => void> = []
  private attention: { readonly sessionId: SessionId; readonly rowVisible: boolean } | undefined
  private transcript: (() => void) | undefined
  private selected: SessionId | undefined
  private inflight: Promise<void> | null = null
  private refetch = false
  private disposed = false

  constructor(
    private readonly remote: SessionReadingRemote,
    private readonly sessions: ReadingSessions,
    private readonly page: ReadingPage,
  ) {}

  /** The current immutable state. */
  getSnapshot = (): SessionReadingState => this.state

  /** Subscribe to state replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Apply a reader mark by hand. */
  readonly mark = (sessionId: SessionId, action: SessionReadingAction): void => {
    if (this.disposed) return
    if (action === 'unread' && sessionId === this.selected) this.held.add(sessionId)
    void this.send(sessionId, action)
  }

  /** Report whether the session list currently renders one session's row. */
  readonly report = (sessionId: SessionId, rowVisible: boolean): void => {
    this.attention = { sessionId, rowVisible }
    this.acknowledge()
  }

  private state: SessionReadingState = Object.freeze({
    unread: NO_ROWS,
    mark: this.mark,
    report: this.report,
  })

  /**
   * Follow the ledger, the selection, and page attention.
   * @returns the disposer that ends the following.
   */
  start(): () => void {
    this.unsubscribers.push(this.sessions.list.subscribe(this.followList))
    this.unsubscribers.push(this.page.onFocusedChange(this.acknowledge))
    this.followList()
    void this.refresh()
    return () => { this.dispose() }
  }

  /**
   * Re-read the ledger. Calls that arrive while a fetch is in flight collapse
   * into one trailing fetch.
   * @returns the fetch this call joined or started.
   */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inflight !== null) {
      this.refetch = true
      return this.inflight
    }
    this.inflight = this.load().finally(() => {
      this.inflight = null
      if (this.refetch && !this.disposed) {
        this.refetch = false
        void this.refresh()
      }
    })
    return this.inflight
  }

  /** The Host signalled a ledger change or a new connection: re-read it. */
  invalidate = (): Promise<void> => this.refresh()

  /** Drop every subscription and ignore whatever is still in flight. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.detachTranscript()
    this.listeners.clear()
  }

  /** The selection may have moved: follow its transcript and re-evaluate. */
  private readonly followList = (): void => {
    const current = this.sessions.list.getSnapshot().current
    if (current !== this.selected) {
      if (this.selected !== undefined) this.held.delete(this.selected)
      this.selected = current
      this.detachTranscript()
    }
    if (current !== undefined && this.transcript === undefined) {
      const source = this.sessions.binding(current)?.session
      if (source !== undefined) this.transcript = source.subscribe(this.acknowledge)
    }
    this.acknowledge()
  }

  /**
   * Acknowledge the selected session's completed turn, but only when every
   * attention fact holds at once: the page is focused, its row is rendered,
   * and the transcript shows the turn the ledger credits (see
   * {@link showsLedgerTurn}).
   */
  private readonly acknowledge = (): void => {
    if (this.disposed || !this.page.focused()) return
    const sessionId = this.selected
    if (sessionId === undefined || this.attention?.sessionId !== sessionId || !this.attention.rowVisible) return
    if (this.held.has(sessionId) || this.acknowledging.has(sessionId)) return
    const record = this.records.get(sessionId)
    if (record === undefined || !isUnread(record)) return
    const transcript = this.sessions.binding(sessionId)?.session.getSnapshot()
    if (transcript === undefined || !showsLedgerTurn(transcript, record)) return
    this.acknowledging.add(sessionId)
    void this.send(sessionId, 'read').then((landed) => {
      if (!landed) this.acknowledging.delete(sessionId)
    })
  }

  /** Send one mark; a landed mark re-reads the ledger. */
  private async send(sessionId: SessionId, action: SessionReadingAction): Promise<boolean> {
    try {
      const carried = await this.remote.mark(sessionId, action)
      if (!carried.ok) {
        console.warn('[session-reading] mark was refused:', carried.error.message)
        return false
      }
    } catch (error) {
      console.warn('[session-reading] mark failed:', describeFailure(error))
      return false
    }
    if (action === 'read') this.held.delete(sessionId)
    await this.refresh()
    return true
  }

  /** Read the ledger once; a refused or broken read keeps the previous mirror. */
  private async load(): Promise<void> {
    try {
      const carried = await this.remote.list()
      if (this.disposed) return
      if (!carried.ok) {
        console.warn('[session-reading] ledger fetch was refused:', carried.error.message)
        return
      }
      this.replace(carried.value.records)
    } catch (error) {
      console.warn('[session-reading] ledger fetch failed:', describeFailure(error))
    }
  }

  /** Adopt a fetched ledger, then publish and re-evaluate against it. */
  private replace(records: readonly SessionReadingRecord[]): void {
    this.records = new Map(records.map(record => [record.sessionId, record]))
    this.acknowledging.clear()
    for (const record of records) {
      if (record.manualUnread && record.sessionId === this.selected) this.held.add(record.sessionId)
    }
    this.publish()
    this.acknowledge()
  }

  /** Publish the unread rows when they moved; a failing subscriber never starves the rest. */
  private publish(): void {
    const unread: Record<string, SessionReadingUnread> = Object.create(null) as Record<string, SessionReadingUnread>
    for (const [sessionId, record] of this.records) {
      if (isUnread(record)) unread[sessionId] = { failed: record.failed }
    }
    const rows = Object.freeze(unread) as SessionReadingUnreadRows
    if (sameRows(rows, this.state.unread)) return
    this.state = Object.freeze({ unread: rows, mark: this.mark, report: this.report })
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[session-reading] subscriber threw:', error)
      }
    }
  }

  /** Stop following the selected session's transcript. */
  private detachTranscript(): void {
    this.transcript?.()
    this.transcript = undefined
  }
}
