import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSessionContractDigest, diffSessionContractDigest, parseSessionContractDigest } from './gen-session-contract-digest.ts'

const START = '<!-- compat-convention-start -->'
const END = '<!-- compat-convention-end -->'

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

describe('ledger compat convention', () => {
  it('accepts rows that declare a stance and non-none rows that name a verifier', async () => {
    const { checkLedgerCompat } = await import('./verify-ledger-compat.ts')
    const good = [
      '## Downstream Commit Ledger',
      '',
      '| Commit | Plugin-level effect |',
      '|---|---|',
      '| `abc123` | Adds a tool. Compat: none. |',
      '| `def456` | Extends the session vocabulary. Compat: v0 additive (new event type). Verify: pnpm run verify-session-contract-digest. |',
      START,
      '| `789abc` | Adds another tool. Compat: none. |',
      '| `012def` | Widens a payload. Compat: v0 additive (optional field). Verify: pnpm run verify-persistence-catalog. |',
      END,
      '',
    ].join('\n')
    expect(checkLedgerCompat(good)).toEqual([])
  })

  it('reports missing markers and non-compliant rows by line', async () => {
    const { checkLedgerCompat } = await import('./verify-ledger-compat.ts')
    expect(checkLedgerCompat('| Commit | effect |\n|---|---|\n| `abc` | no markers. |')).toEqual([
      { where: 'PLUGINS.md:1', problem: 'missing <!-- compat-convention-start -->; add the marker around ledger rows recorded under the compat convention.' },
    ])
    const bad = [
      '| Commit | Plugin-level effect |',
      START,
      '| `abc` | Adds a tool without a stance. |',
      '| `def` | Touches the log. Compat: v0 additive. |',
      '| `ghi` | Touches nothing. Compat:  |',
      END,
    ].join('\n')
    const findings = checkLedgerCompat(bad)
    expect(findings.map(f => f.where)).toEqual(['PLUGINS.md:4', 'PLUGINS.md:5', 'PLUGINS.md:6'])
    expect(findings[0]?.problem).toContain('no Compat: tail')
    expect(findings[1]?.problem).toContain('lacks a Verify: command tail')
    expect(findings[2]?.problem).toContain('no claim sentence')
  })
})
