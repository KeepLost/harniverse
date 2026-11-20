/** Durable per-peer turn-budget governance: `peer-governance.json` under the accepting instance's home. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PeerError } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerInstanceId } from '@deepseek-ai/dsh-peer-protocol'

/** Ceiling for one configured monthly turn budget; larger owner input is rejected. */
export const PEER_BUDGET_MAX_TURNS = 1_000_000

/** How many monthly periods one entry retains; writes prune anything older. */
const RETAINED_PERIODS = 2

/** Upper bound on periods accepted when parsing; guards malformed files, not a policy. */
const MAX_PARSE_PERIODS = 24

/** Budget state of one peer: the optional cap plus per-period delivered-turn counts. */
export interface PeerGovernanceEntry {
  instanceId: PeerInstanceId
  /** Monthly delivered-turn cap; absent means unlimited. */
  monthlyTurns?: number
  /** Delivered turns keyed by UTC period `YYYY-MM`. */
  spent: Record<string, number>
}

/** Durable file shape of the governance store. */
export interface PeerGovernanceFile { version: 1; entries: PeerGovernanceEntry[] }

/**
 * Resolve the governance store path inside one home.
 * @param home - absolute Harness home directory.
 * @returns the `peer-governance.json` path.
 */
export function peerGovernancePath(home: string): string {
  return join(home, 'peer-governance.json')
}

/**
 * Read and validate the complete governance store; an absent file is an empty store.
 * @param home - absolute Harness home directory.
 * @returns the stored entries in insertion order.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for malformed documents.
 */
export async function readPeerGovernance(home: string): Promise<PeerGovernanceEntry[]> {
  let text: string
  try {
    text = await readFile(peerGovernancePath(home), 'utf8')
  } catch {
    return []
  }
  if (typeof text !== 'string' || text.trim() === '') return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PeerError('CORRUPT_INSTANCE', 'peer-governance.json is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer-governance.json is not an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.entries)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer-governance.json has an unsupported shape')
  }
  return record.entries.map(entry => parsePeerGovernanceEntry(entry))
}

/**
 * Parse and validate one stored governance entry.
 * @param value - candidate entry value.
 * @returns the validated entry.
 * @throws a {@link PeerError} with `CORRUPT_INSTANCE` for malformed entries.
 */
export function parsePeerGovernanceEntry(value: unknown): PeerGovernanceEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer governance entry is not an object')
  }
  const record = value as unknown as Record<string, unknown>
  const keys = ['instanceId', 'spent']
  const present = Object.keys(record)
  if (keys.some(key => !(key in record)) || present.length > keys.length + 1
    || (present.length === keys.length + 1 && !('monthlyTurns' in record))) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer governance entry fields mismatch')
  }
  if (typeof record.instanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.instanceId)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer governance entry owner')
  }
  if ('monthlyTurns' in record && (!Number.isInteger(record.monthlyTurns)
    || (record.monthlyTurns as number) < 1 || (record.monthlyTurns as number) > PEER_BUDGET_MAX_TURNS)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer governance entry budget')
  }
  if (typeof record.spent !== 'object' || record.spent === null || Array.isArray(record.spent)) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer governance entry spent')
  }
  const spent = record.spent as Record<string, unknown>
  const periods = Object.keys(spent)
  if (periods.length > MAX_PARSE_PERIODS) {
    throw new PeerError('CORRUPT_INSTANCE', 'peer governance entry spent periods')
  }
  for (const [period, turns] of Object.entries(spent)) {
    if (!/^\d{4}-\d{2}$/.test(period) || !Number.isInteger(turns) || (turns as number) < 0) {
      throw new PeerError('CORRUPT_INSTANCE', 'peer governance entry spent field')
    }
  }
  return record as unknown as PeerGovernanceEntry
}

/** Non-secret failure classification for a storage write error.
 * @param error - the thrown failure.
 * @returns the error's constructor name, or a fixed label for non-Error throws.
 */
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : /* v8 ignore next -- every filesystem failure is an Error; the label names the impossible */ 'write failed'
}

/**
 * Atomically persist the complete governance store with owner-only permissions.
 * @param home - absolute Harness home directory.
 * @param entries - complete entry list replacing the store.
 */
export async function writePeerGovernance(home: string, entries: readonly PeerGovernanceEntry[]): Promise<void> {
  const document: PeerGovernanceFile = { version: 1, entries: [...entries] }
  const target = peerGovernancePath(home)
  const staging = join(dirname(target), `.peer-governance.json.${process.pid.toString(36)}`)
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(staging, `${JSON.stringify(document)}\n`, { mode: 0o600 })
    await rename(staging, target)
  } catch (error) {
    throw new PeerError('STORE_FAILED', failureName(error))
  }
}

/**
 * Derive the UTC period label of one moment.
 * @param now - the moment to label.
 * @returns the `YYYY-MM` period key.
 */
export function periodOf(now: Date): string {
  return `${now.getUTCFullYear().toString().padStart(4, '0')}-${(now.getUTCMonth() + 1).toString().padStart(2, '0')}`
}

/** Whether one desired surface stays inside the granted one field-by-field.
 * @param granted - the surface currently in force.
 * @param desired - the complete requested surface.
 * @returns `true` when no field widens, so the change may commit without approval.
 */
type SurfaceFlags = { delegate: boolean; message: boolean; list: boolean }

export function isNarrowing(granted: SurfaceFlags, desired: SurfaceFlags): boolean {
  return (!desired.delegate || granted.delegate) && (!desired.message || granted.message) && (!desired.list || granted.list)
}

/**
 * Reject one peer's next delivered turn when its monthly budget is exhausted.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified calling peer.
 * @param now - the delivery moment.
 * @throws a {@link PeerError} with `BUDGET_EXCEEDED` when the current period is at or past the cap.
 */
export async function authorizePeerTurn(
  home: string,
  instanceId: PeerInstanceId,
  now: Date,
): Promise<void> {
  const entry = (await readPeerGovernance(home)).find(item => item.instanceId === instanceId)
  if (entry?.monthlyTurns === undefined) return
  const period = periodOf(now)
  if ((entry.spent[period] ?? 0) >= entry.monthlyTurns) {
    throw new PeerError('BUDGET_EXCEEDED', `${period} limit ${entry.monthlyTurns}`)
  }
}

/**
 * Record one accepted delivered turn against the peer's current period.
 * @param home - absolute Harness home directory.
 * @param instanceId - the verified calling peer whose turn was accepted.
 * @param now - the delivery moment.
 */
export async function recordPeerTurn(home: string, instanceId: PeerInstanceId, now: Date): Promise<void> {
  const entries = await readPeerGovernance(home)
  const period = periodOf(now)
  const existing = entries.find(item => item.instanceId === instanceId)
  if (existing === undefined) {
    await writePeerGovernance(home, [...entries, { instanceId, spent: { [period]: 1 } }])
    return
  }
  const pruned: Record<string, number> = {}
  const keep = new Set(orderedPeriods(period).slice(-RETAINED_PERIODS))
  for (const [key, turns] of Object.entries(existing.spent)) {
    if (keep.has(key)) pruned[key] = turns
  }
  pruned[period] = (pruned[period] ?? 0) + 1
  const updated = entries.map(item => item.instanceId === instanceId ? { ...item, spent: pruned } : item)
  await writePeerGovernance(home, updated)
}

/**
 * Read one peer's budget summary for the admin view.
 * @param home - absolute Harness home directory.
 * @param instanceId - the paired peer.
 * @param now - the moment the view is taken for.
 * @returns the cap when configured and the current period's delivered turns.
 */
export async function peerBudgetView(
  home: string,
  instanceId: PeerInstanceId,
  now: Date,
): Promise<{ monthlyTurns?: number; monthlyTurnsUsed: number; monthlyTurnPeriod: string }> {
  const period = periodOf(now)
  const entry = (await readPeerGovernance(home)).find(item => item.instanceId === instanceId)
  return {
    ...entry?.monthlyTurns === undefined ? {} : { monthlyTurns: entry.monthlyTurns },
    monthlyTurnsUsed: entry?.spent[period] ?? 0,
    monthlyTurnPeriod: period,
  }
}

/**
 * Set or clear one peer's monthly turn budget.
 * @param home - absolute Harness home directory.
 * @param instanceId - the paired peer.
 * @param monthlyTurns - the new cap, or `undefined` to lift the budget.
 */
export async function setPeerBudget(home: string, instanceId: PeerInstanceId, monthlyTurns: number | undefined): Promise<void> {
  const entries = await readPeerGovernance(home)
  const existing = entries.find(item => item.instanceId === instanceId)
  if (existing === undefined) {
    if (monthlyTurns === undefined) return
    await writePeerGovernance(home, [...entries, { instanceId, monthlyTurns, spent: {} }])
    return
  }
  const updated = entries.map((item) => {
    if (item.instanceId !== instanceId) return item
    if (monthlyTurns === undefined) {
      const { monthlyTurns: lifted, ...rest } = item
      void lifted
      return rest
    }
    return { ...item, monthlyTurns }
  })
  await writePeerGovernance(home, stripEmptyBudget(updated, instanceId))
}

/** Drop one entry that carries neither a cap nor recorded turns.
 * @param entries - complete entry list.
 * @param instanceId - the entry just edited.
 * @returns the list with the named entry removed when it became inert.
 */
function stripEmptyBudget(entries: readonly PeerGovernanceEntry[], instanceId: PeerInstanceId): PeerGovernanceEntry[] {
  const edited = entries.find(item => item.instanceId === instanceId)
  /* v8 ignore next -- both callers map an entry for the id first, so the find cannot miss */
  if (edited === undefined) return [...entries]
  if (edited.monthlyTurns !== undefined || Object.keys(edited.spent).length > 0) return [...entries]
  return entries.filter(item => item.instanceId !== instanceId)
}

/** The two period keys around one period, for retention pruning.
 * @param period - the current `YYYY-MM` period.
 * @returns the current and previous period keys, previous first.
 */
function orderedPeriods(period: string): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  /* v8 ignore next 2 -- callers pass generated period labels; the guard names the impossible */
  if (match === null) return [period]
  const year = Number(match[1])
  const month = Number(match[2])
  const previous = month === 1 ? `${(year - 1).toString().padStart(4, '0')}-12` : `${year}-${(month - 1).toString().padStart(2, '0')}`
  return [previous, period]
}
