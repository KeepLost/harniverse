/**
 * Incremental projection of durable agent inbox events.
 *
 * @module @deepseek-ai/dsh-agent/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type { InboxTarget } from './types.ts'

/** Mutable state privately owned by an {@link Inbox}. */
type InboxState = Record<InboxTarget, UserMessage[]>

/** Claims for an unopened step: the current batch, and the batch an interrupted turn left behind. */
type InboxClaims = Record<'pending' | 'interrupted', UserMessage[]>

/** A normalized durable inbox splice. */
type InboxSplice = SessionEventMap['agent/inbox/spliced']

/** Live notifications committed by inbox mutations. */
export interface InboxNotifications {
  /** Publish one inserted message. */
  inserted(message: UserMessage): void
  /** Publish one discarded message. */
  discarded(message: UserMessage): void
  /** Publish one claimed message inside its owning turn. */
  claimed(message: UserMessage, turn: number): void
}

/**
 * A replay-once projection that incrementally consumes later inbox splices.
 * It also folds the claims a turn took for a step that never opened, so the
 * inbox can return them when the turn fails or was interrupted.
 */
export class Inbox {
  private readonly state: InboxState = { 'next-turn': [], 'next-step': [] }
  private readonly claims: InboxClaims = { pending: [], interrupted: [] }
  /** Whether {@link clear} discarded the batch taken by the latest {@link claim}. */
  private claimDiscarded = false

  constructor(
    private readonly session: Session,
    private readonly notifications: InboxNotifications,
  ) {
    for (const event of session.events.slice(session.header.seedLength ?? 0)) {
      if (event.type !== 'agent/inbox/spliced') {
        this.settle(event)
        continue
      }
      try {
        this.record(event.data, this.apply(event.data))
      } catch (error: unknown) {
        throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
      }
    }
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.state['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.state['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.claimDiscarded = true
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step, publishing
   * each claimed message. The durable splices are pure deletions.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   * @internal - The agent loop's step-boundary operation, not a plugin extension point.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    this.claimDiscarded = false
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') {
      claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    }
    for (const message of claimed) this.notifications.claimed(message, turn)
    return claimed
  }

  /**
   * Return the batch claimed for an unopened step to the next-turn head when
   * the turn ends before `step/start`, unless {@link clear} discarded it.
   * Call before `turn/end` settles the claim.
   * @throws when the Session refuses the return; the claim stays settled by `turn/end`.
   * @internal - The agent loop's turn-failure operation, not a plugin extension point.
   */
  returnClaims(): void {
    if (!this.claimDiscarded) this.returnClaim('pending')
  }

  /**
   * Return the claim an interrupted turn left for an unopened step; a no-op
   * after a turn that closed.
   * @throws when the Session refuses the return.
   * @internal - The agent factory's resume operation, not a plugin extension point.
   */
  restoreInterrupted(): void {
    this.returnClaim('interrupted')
  }

  /**
   * Settle the claim record at a durable boundary the machine appended:
   * `step/start` settles the batch it opens, and `turn/end` settles the batch
   * its turn took, keeping it only when the turn was interrupted. The
   * constructor replays the same events, so a resumed agent reads what a live
   * one wrote; a seeded session replays only its own events.
   * @param event - `step/start` or `turn/end` event.
   * @internal - The agent machine's boundary operation, not a plugin extension point.
   */
  settle(event: SessionEvent): void {
    const { pending, interrupted } = this.claims
    switch (event.type) {
      case 'step/start':
        pending.length = 0
        break
      case 'turn/end':
        if (event.data.reason.kind === 'interrupted') interrupted.push(...pending)
        else interrupted.length = 0
        pending.length = 0
        break
      default:
        // Other Session events leave the claim record unchanged.
        break
    }
  }

  /**
   * Append one message to a pending list and durably record the insertion.
   * @param target - pending list to extend.
   * @param message - message to append.
   * @throws if the message identity is already pending.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.state[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list and durably record the insertion.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   * @throws if the message identity is already pending.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place, possibly changing its identity. A
   * successful replacement publishes the old message as discarded and the new
   * message as inserted.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   * @throws if the replacement duplicates another pending message identity.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message and durably record its cancellation.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * The durable event commits before the live projection mutates, so synchronous
   * `session/event` observers see the pre-splice lists and can reconstruct the
   * removed messages from the normalized coordinates.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Prepend one claim list in order, skipping any occurrence already queued. */
  private returnClaim(source: keyof InboxClaims): void {
    const claims = this.claims[source]
    if (claims.length === 0) return
    const queued = new Set([...this.nextTurn, ...this.nextStep].map(message => message.id))
    this.splice('next-turn', 0, 0, claims.filter(message => !queued.has(message.id)))
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /**
   * Fold one committed splice's removals into the claim record: a removal
   * without an outcome is a claim, and a cancellation drops its identities
   * from either claim list unless the same splice inserts them again.
   */
  private record(splice: InboxSplice, removed: readonly UserMessage[]): void {
    if (removed.length === 0) return
    const { pending, interrupted } = this.claims
    if (splice.outcome !== 'canceled') {
      pending.push(...removed)
      return
    }
    const discarded = new Set(removed.map(message => message.id))
    for (const message of splice.inserted) discarded.delete(message.id)
    this.claims.pending = pending.filter(message => !discarded.has(message.id))
    this.claims.interrupted = interrupted.filter(message => !discarded.has(message.id))
  }

  /** Commit one normalized mutation and publish its live notifications. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const inbox = this.state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: InboxSplice = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    this.validate(splice)
    const event = this.session.append('agent/inbox/spliced', splice)
    const removed = inbox.splice(actualStart, actualDeleteCount, ...event.data.inserted)
    this.record(event.data, removed)
    if (discardRemoved) {
      for (const message of removed) this.notifications.discarded(message)
    }
    for (const message of event.data.inserted) this.notifications.inserted(message)
    return removed
  }

  /** Apply one normalized durable splice to the projection. */
  private apply(splice: InboxSplice): UserMessage[] {
    this.validate(splice)
    const inbox = this.state[splice.target]
    return inbox.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  }

  /** Validate one normalized splice against the current projection. */
  private validate(splice: InboxSplice): void {
    const inbox = this.state[splice.target]
    const removedCount = splice.removedCount ?? 0
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0
      || splice.start + removedCount > inbox.length) {
      throw new Error('invalid inbox splice')
    }
    const candidate = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
    const ids = new Set<string>()
    for (const message of splice.target === 'next-turn'
      ? [...candidate, ...this.nextStep]
      : [...this.nextTurn, ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
  }
}
