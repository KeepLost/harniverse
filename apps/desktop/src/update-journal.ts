/** Pure update decisions. Persist the returned journal atomically before executing its state. */
export interface UpdateCandidate {
  current: string
  next: string
  artifact: string
  sha256: string
}

type UpdateState = 'awaiting-consent' | 'declined' | 'draining' | 'stopping-owned-host'
  | 'ready' | 'installing' | 'handoff' | 'verifying' | 'complete' | 'failed' | 'rollback-required' | 'rolled-back'

export type UpdateEvent =
  | { type: 'offered' | 'consent' | 'decline' | 'owned-host-stopped' | 'begin-install'
    | 'installed' | 'handed-off' | 'healthy' | 'rolled-back' | 'retained' | 'recovered' }
  | { type: 'drained'; activeWork: number; admissionClosed: boolean; ownedHost: boolean }
  | { type: 'failed'; reason: string }

export interface UpdateJournal {
  schemaVersion: 1
  candidate: UpdateCandidate
  state: UpdateState
  rollbackVersion: string | undefined
  entries: readonly UpdateEvent[]
}

/**
 * Create a consent request for a locally verified artifact; performs no downloads or process control.
 * @param candidate - current and newer release versions with exact artifact metadata.
 * @returns the initial immutable journal.
 */
export function createUpdate(candidate: UpdateCandidate): UpdateJournal {
  if (compareVersions(candidate.next, candidate.current) <= 0) throw new Error('update version must be newer; same versions and downgrades are refused')
  if (typeof candidate.artifact !== 'string' || !/^[\w][\w. -]*$/.test(candidate.artifact)) {
    throw new Error('update artifact must be a local filename')
  }
  if (!/^[a-f0-9]{64}$/.test(candidate.sha256)) throw new Error('update artifact requires SHA-256')
  return {
    schemaVersion: 1, candidate: { ...candidate }, state: 'awaiting-consent',
    rollbackVersion: undefined, entries: [{ type: 'offered' }],
  }
}

/**
 * Advance one immutable decision. A stopped event acknowledges Host exit, never a kill request.
 * @param journal - validated current checkpoint.
 * @param event - next observed or consented lifecycle event.
 * @returns the next immutable checkpoint, or throws for an inadmissible transition.
 */
export function transitionUpdate(journal: UpdateJournal, event: UpdateEvent): UpdateJournal {
  let state: UpdateState | undefined
  let rollbackVersion = journal.rollbackVersion
  switch (event.type) {
    case 'consent':
      if (journal.state === 'awaiting-consent') state = 'draining'
      break
    case 'decline':
      if (journal.state === 'awaiting-consent') state = 'declined'
      break
    case 'drained':
      if (journal.state !== 'draining') break
      if (!Number.isSafeInteger(event.activeWork) || event.activeWork !== 0) throw new Error('active work must drain to zero')
      if (!event.admissionClosed) throw new Error('work admission must be closed before drain acknowledgment')
      if (typeof event.ownedHost !== 'boolean') throw new Error('ownedHost must be explicit')
      state = event.ownedHost ? 'stopping-owned-host' : 'ready'
      break
    case 'owned-host-stopped':
      if (journal.state === 'stopping-owned-host') state = 'ready'
      break
    case 'begin-install':
      if (journal.state === 'ready') {
        state = 'installing'
        rollbackVersion = journal.candidate.current
      }
      break
    case 'installed':
      if (journal.state === 'installing') state = 'verifying'
      break
    case 'handed-off':
      if (journal.state === 'installing') state = 'handoff'
      break
    case 'healthy':
      if (journal.state === 'verifying' || journal.state === 'handoff') state = 'complete'
      break
    case 'failed':
      if (typeof event.reason !== 'string' || event.reason.trim() === '') throw new Error('update failure requires a reason')
      if (['draining', 'stopping-owned-host', 'ready', 'handoff'].includes(journal.state)) state = 'failed'
      if (['installing', 'verifying', 'rollback-required'].includes(journal.state)) state = 'rollback-required'
      break
    case 'rolled-back':
      if (journal.state === 'rollback-required') state = 'rolled-back'
      break
    case 'retained':
      if (journal.state === 'rollback-required') state = 'failed'
      break
    case 'recovered':
      state = journal.state
      if (['draining', 'stopping-owned-host', 'ready'].includes(state)) state = 'awaiting-consent'
      if (['installing', 'verifying'].includes(state)) state = 'rollback-required'
      break
    case 'offered':
      break
    default: {
      const invalid: never = event
      throw new Error(`unknown update event: ${JSON.stringify(invalid)}`)
    }
  }
  if (state === undefined) throw new Error(`invalid update transition: ${journal.state} -> ${event.type}`)
  return { ...journal, state, rollbackVersion, entries: [...journal.entries, { ...event }] }
}

/**
 * Replay untrusted durable JSON and reject inconsistent summaries.
 * @param value - parsed durable JSON.
 * @returns the verified checkpoint without performing recovery effects.
 */
export function parseUpdateJournal(value: unknown): UpdateJournal {
  if (value === null || typeof value !== 'object') throw new Error('invalid update journal')
  const input = value as Partial<UpdateJournal> & { entries?: unknown }
  if (input.schemaVersion !== 1 || !input.candidate || !Array.isArray(input.entries)
    || input.entries.length === 0 || input.entries.length > 256) {
    throw new Error('invalid update journal schema')
  }
  const entries: unknown[] = input.entries
  const first = entries[0]
  if (typeof first !== 'object' || first === null || !('type' in first) || first.type !== 'offered') {
    throw new Error('invalid update journal opening event')
  }
  let journal = createUpdate(input.candidate)
  for (const entry of entries.slice(1)) {
    if (entry === null || typeof entry !== 'object' || !('type' in entry) || typeof entry.type !== 'string') {
      throw new Error('invalid update journal entry')
    }
    if (entry.type === 'drained' && (!('activeWork' in entry) || typeof entry.activeWork !== 'number'
      || !('admissionClosed' in entry) || typeof entry.admissionClosed !== 'boolean'
      || !('ownedHost' in entry) || typeof entry.ownedHost !== 'boolean')) throw new Error('invalid update drain event')
    if (entry.type === 'failed' && (!('reason' in entry) || typeof entry.reason !== 'string')) throw new Error('invalid update failure event')
    // The transition function validates the closed event type and every state-dependent payload.
    journal = transitionUpdate(journal, entry as UpdateEvent)
  }
  if (journal.state !== input.state || journal.rollbackVersion !== input.rollbackVersion) {
    throw new Error('update journal summary does not match its entries')
  }
  return journal
}

/**
 * Replay durable decisions and require renewed consent after an interrupted drain.
 * @param value - parsed durable JSON.
 * @returns a recovered decision requiring the caller to perform and persist any restoration.
 */
export function recoverUpdate(value: unknown): UpdateJournal {
  return transitionUpdate(parseUpdateJournal(value), { type: 'recovered' })
}

/**
 * Compare strict semantic versions, including numeric prerelease precedence; build metadata has no precedence.
 * @param left - candidate version.
 * @param right - comparison version.
 * @returns negative, zero or positive for older, equal or newer precedence.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (input: string) => {
    if (typeof input !== 'string' || input.length > 128) throw new Error('update version must be a semantic version')
    const semanticVersion =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/
    const match = semanticVersion.exec(input)
    if (match === null || match[4]?.split('.').some(part => /^0\d+$/.test(part))) {
      throw new Error('update version must be a semantic version')
    }
    return { core: match.slice(1, 4).map(part => BigInt(part)), pre: match[4]?.split('.') }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index++) {
    const x = a.core[index] ?? 0n
    const y = b.core[index] ?? 0n
    if (x !== y) return x > y ? 1 : -1
  }
  if (a.pre === undefined || b.pre === undefined) return a.pre === b.pre ? 0 : a.pre === undefined ? 1 : -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1
    if (numericX !== numericY) return numericX ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}
