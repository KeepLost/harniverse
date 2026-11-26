/**
 * Host memory of per-session reading state. Durable `turn/end` events advance
 * each session's completed turn, the `sessionReading` Remote reads the ledger
 * and applies reader marks, and every change announces itself through the
 * payload-less `sessionReading/changed` event. The ledger lives in process
 * memory and is shared by every browser and principal of this Host.
 * @module @deepseek-ai/dsh-client-session-reading
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionReadingAction,
  SessionReadingListValue,
  SessionReadingMarkValue,
  SessionReadingRecord,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionReading: SessionReadingService
  }
}

/** One mutable ledger row; only frozen copies leave the service. */
type LedgerRow = { -readonly [Field in keyof SessionReadingRecord]: SessionReadingRecord[Field] }

/** Whether a record still asks for the reader's attention. */
function isUnread(row: SessionReadingRecord): boolean {
  return row.manualUnread || row.completedTurn > row.readTurn
}

/** Freeze one detached copy of a ledger row for the wire. */
function snapshot(row: LedgerRow): SessionReadingRecord {
  return Object.freeze({ ...row })
}

/** The row one mark stores, or `undefined` when the session already carries that state. */
function marked(sessionId: SessionId, row: LedgerRow | undefined, action: SessionReadingAction): LedgerRow | undefined {
  if (action === 'unread') {
    if (row?.manualUnread === true) return undefined
    return {
      sessionId,
      completedTurn: row?.completedTurn ?? 0,
      failed: row?.failed ?? false,
      readTurn: row?.readTurn ?? 0,
      manualUnread: true,
    }
  }
  if (row === undefined || !isUnread(row)) return undefined
  return { ...row, readTurn: row.completedTurn, manualUnread: false }
}

/** Reading ledger behind `ctx.sessionReading`. */
export class SessionReadingService extends TypertRemoteService {
  static inject = ['sessions']

  private readonly ledger = new Map<SessionId, LedgerRow>()
  private readonly owner: Context

  constructor(ctx: Context) {
    super(ctx, 'sessionReading')
    this.owner = ctx
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      this.settle(session.id, event.data.turn, event.data.reason.kind === 'error')
    })
  }

  /**
   * Read every record the Host holds.
   * @returns frozen copies in first-settlement order.
   */
  @Remote({ requiredCapability: 'harniverse.observe' })
  list(): Promise<SessionReadingListValue> {
    return Promise.resolve(Object.freeze({ records: Object.freeze([...this.ledger.values()].map(snapshot)) }))
  }

  /**
   * Apply one reader action. `read` acknowledges every completed turn and
   * lowers a manual mark; `unread` raises the manual mark. A session already
   * carrying the requested state is returned unchanged and announces nothing.
   * @param sessionId - session the action addresses.
   * @param action - reader action.
   * @returns the stored record, or absence when the session holds none and `read` asked for no change.
   */
  @Remote({ requiredCapability: 'harniverse.operate' })
  mark(sessionId: SessionId, action: SessionReadingAction): Promise<SessionReadingMarkValue> {
    const current = this.ledger.get(sessionId)
    const row = marked(sessionId, current, action)
    if (row !== undefined) {
      this.ledger.set(sessionId, row)
      this.announce()
    }
    const stored = row ?? current
    return Promise.resolve({ record: stored === undefined ? null : snapshot(stored) })
  }

  /**
   * Fold one durable turn settlement into the ledger. Turn numbers grow
   * inside one log, so a settlement at or below the recorded turn means the
   * id now carries another log, whose record starts over.
   */
  private settle(sessionId: SessionId, turn: number, failed: boolean): void {
    const row = this.ledger.get(sessionId)
    if (row !== undefined && turn > row.completedTurn) {
      row.completedTurn = turn
      row.failed = failed
    } else {
      this.ledger.set(sessionId, {
        sessionId,
        completedTurn: turn,
        failed,
        readTurn: 0,
        manualUnread: false,
      })
    }
    this.announce()
  }

  /** Announce that the ledger moved; `list()` stays the authoritative read. */
  private announce(): void {
    this.owner.emit('sessionReading/changed')
  }
}

export default SessionReadingService
