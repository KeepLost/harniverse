/**
 * Shared-pool quota book: the pure admission arithmetic the governor applies.
 * Sessions without an explicit quota ride the shared pool bounded by the
 * global budget; explicit quotas are isolation leaves whose committed sum
 * must stay within the budget, so a raise is clamped or rejected by what the
 * other active sessions have already claimed. Durability is injected: the
 * authoritative copy lives in the governor's storage-domain table.
 * @module @deepseek-ai/dsh-governor/quota
 */

import type { QuotaOverrideRecord } from './types.ts'

/** Durable override storage the book persists decided quotas through. */
export interface QuotaOverrideStore {
  entries(): IterableIterator<[string, QuotaOverrideRecord]>
  put(sessionId: string, record: QuotaOverrideRecord): Promise<void>
  delete(sessionId: string): Promise<boolean>
}

/** Result of one admission request. */
export interface AdmissionResult {
  /** The quota that was actually granted (<= the requested amount). */
  readonly grantedBytes: number
  /** True when the request was clamped down from what was asked. */
  readonly clamped: boolean
}

/** Smallest quota the book will grant; below this a raise is meaningless. */
export const MIN_QUOTA_BYTES = 64 * 1024 * 1024

/**
 * Admission arithmetic over one session's explicit quota against the global
 * budget and every other session's committed quota.
 */
export class QuotaBook {
  private readonly overrides = new Map<string, QuotaOverrideRecord>()
  private readonly store: QuotaOverrideStore | undefined
  private readonly getGlobalLimitBytes: () => number
  private persistQueue: Promise<unknown> = Promise.resolve()

  constructor(getGlobalLimitBytes: () => number, store?: QuotaOverrideStore) {
    this.getGlobalLimitBytes = getGlobalLimitBytes
    this.store = store
  }

  /**
   * Load persisted overrides into the book (boot and resume path).
   * @returns the loaded rows.
   */
  load(): QuotaOverrideRecord[] {
    if (this.store === undefined) return []
    const rows: QuotaOverrideRecord[] = []
    for (const [sessionId, record] of this.store.entries()) {
      this.overrides.set(sessionId, record)
      rows.push(record)
    }
    return rows
  }

  /**
   * The budget enforcement currently applies to one session: its explicit
   * quota when it has one, else the shared-pool global budget.
   * @param sessionId - session id.
   * @returns effective limit in bytes.
   */
  effectiveLimitBytes(sessionId: string): number {
    return this.overrides.get(sessionId)?.memoryBytes ?? this.getGlobalLimitBytes()
  }

  /**
   * True while the session rides the shared pool (no explicit quota).
   * @param sessionId - session id.
   * @returns pool membership.
   */
  isShared(sessionId: string): boolean {
    return !this.overrides.has(sessionId)
  }

  /**
   * One session's explicit quota record.
   * @param sessionId - session id.
   * @returns the decided override, or undefined for pool members.
   */
  override(sessionId: string): QuotaOverrideRecord | undefined {
    return this.overrides.get(sessionId)
  }

  /**
   * Snapshot iterator over decided overrides.
   * @returns `[sessionId, record]` pairs.
   */
  entries(): IterableIterator<[string, QuotaOverrideRecord]> {
    return this.overrides.entries()
  }

  /**
   * Session ids that currently hold explicit quotas.
   * @returns the ids, in insertion order.
   */
  sessionIds(): string[] {
    return [...this.overrides.keys()]
  }

  /** Sum of every OTHER session's committed quota. */
  private committedExcluding(sessionId: string): number {
    let sum = 0
    for (const [id, record] of this.overrides) {
      if (id !== sessionId) sum += record.memoryBytes
    }
    return sum
  }

  /**
   * Admit (or clamp) one requested quota: bounded by the global budget minus
   * what other sessions have committed.
   * @param sessionId - session asking for the quota.
   * @param requestedBytes - the quota it wants.
   * @returns the granted quota and whether clamping happened.
   */
  admit(sessionId: string, requestedBytes: number): AdmissionResult {
    const ceiling = Math.max(0, this.getGlobalLimitBytes() - this.committedExcluding(sessionId))
    const granted = Math.min(requestedBytes, ceiling)
    return { grantedBytes: granted, clamped: granted < requestedBytes }
  }

  /**
   * Record one decided quota (tool negotiation, board action, resume replay).
   * @param sessionId - session id.
   * @param grantedBytes - the granted quota (already admitted).
   * @param reason - why the override exists.
   * @returns resolution after durable persistence.
   */
  async commit(sessionId: string, grantedBytes: number, reason: string): Promise<void> {
    const record: QuotaOverrideRecord = {
      sessionId,
      memoryBytes: grantedBytes,
      updatedAt: Date.now(),
      reason,
    }
    this.overrides.set(sessionId, record)
    await this.enqueue(() => this.store?.put(sessionId, record))
  }

  /**
   * Drop one session's override — it rejoins the shared pool.
   * @param sessionId - session id.
   * @returns resolution after durable persistence.
   */
  async clear(sessionId: string): Promise<boolean> {
    if (!this.overrides.delete(sessionId)) return false
    await this.enqueue(() => this.store?.delete(sessionId))
    return true
  }

  /** Serialize persistence writes through one queue. */
  private enqueue(operation: () => Promise<unknown> | undefined): Promise<void> {
    const next = this.persistQueue.then(operation)
    this.persistQueue = next.catch(() => {})
    return next.then(() => {})
  }

  /**
   * Drop overrides for sessions whose rows are older than the TTL — the
   * abandoned-session sweep.
   * @param now - current epoch milliseconds.
   * @param ttlMs - max age of a still-valid override row.
   * @returns resolution after persistence.
   */
  async sweepAbandoned(now: number, ttlMs: number): Promise<void> {
    for (const [sessionId, record] of [...this.overrides]) {
      if (now - record.updatedAt > ttlMs) await this.clear(sessionId)
    }
  }
}
