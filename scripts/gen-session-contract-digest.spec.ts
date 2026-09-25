import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSessionContractDigest, diffSessionContractDigest, parseSessionContractDigest } from './gen-session-contract-digest.ts'

describe('session contract digest', () => {
  it('locks the committed artifact to the source-extracted contract', () => {
    const committed = readFileSync(resolve(import.meta.dirname, '../docs/session-contract-digest.json'), 'utf8')
    const digest = buildSessionContractDigest()
    expect(committed).toBe(`${JSON.stringify(digest, null, 2)}\n`)
    expect(diffSessionContractDigest(parseSessionContractDigest(committed), digest)).toEqual({ structural: [], additive: [] })
  })

  it('collects a sorted, unique event vocabulary pinned at version 0', () => {
    const digest = buildSessionContractDigest()
    expect(digest.version).toBe(1)
    expect(digest.policy).toBe('v0-additive-only')
    expect(digest.sessionFormatVersion).toBe(0)
    expect(digest.eventTypes).toEqual([...digest.eventTypes].sort())
    expect(new Set(digest.eventTypes).size).toBe(digest.eventTypes.length)
    expect(digest.eventTypes).toContain('turn/start')
    for (const name of digest.eventTypes) expect(typeof digest.eventPayloads[name]).toBe('string')
  })

  it('classifies a new event type as additive, not structural', () => {
    const base = buildSessionContractDigest()
    const widened: typeof base = {
      ...base,
      eventTypes: [...base.eventTypes, 'zz/new-event'],
      eventPayloads: { ...base.eventPayloads, 'zz/new-event': 'string' },
    }
    expect(diffSessionContractDigest(base, widened)).toEqual({ structural: [], additive: ["event type 'zz/new-event' was added."] })
  })

  it('classifies removal, payload change, and version change as structural', () => {
    const base = buildSessionContractDigest()
    const removedName = base.eventTypes[base.eventTypes.length - 1] as string
    const { [removedName]: _removed, ...narrowerPayloads } = base.eventPayloads
    const removed: typeof base = {
      ...base,
      eventTypes: base.eventTypes.filter(name => name !== removedName),
      eventPayloads: narrowerPayloads,
    }
    expect(diffSessionContractDigest(base, removed).structural.join('\n')).toContain(`'${removedName}' was removed`)
    const changedPayload = { ...base.eventPayloads, [removedName]: 'number' } as typeof base.eventPayloads
    expect(diffSessionContractDigest(base, { ...base, eventPayloads: changedPayload }).structural.join('\n')).toContain(`payload of event '${removedName}' changed`)
    expect(diffSessionContractDigest(base, { ...base, sessionFormatVersion: 1 }).structural.join('\n')).toContain('SESSION_FORMAT_VERSION changed')
  })

  it('classifies an envelope hash change as structural', () => {
    const base = buildSessionContractDigest()
    const mutated = { ...base, envelope: base.envelope.map((entry, index) => index === 0 ? { ...entry, structuralSha256: '0'.repeat(64) } : entry) }
    expect(diffSessionContractDigest(base, mutated).structural.join('\n')).toContain('changed structurally')
  })
})
