/**
 * Verify the `Compat:`/`Verify:` ledger-tail convention in `PLUGINS.md`: every
 * downstream ledger row recorded after the `compat-convention-start` marker
 * declares its compatibility stance (`Compat:` claim, `none` when the change
 * touches no durable or public contract) and, for every non-`none` claim, the
 * command that re-verifies it (`Verify:`). Historical rows before the marker
 * stay exempt. Exit 1 reports each offending row with the required fix.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const LEDGER = 'PLUGINS.md'
const START_MARKER = '<!-- compat-convention-start -->'
const END_MARKER = '<!-- compat-convention-end -->'

/** One ledger row's compat convention compliance decision. */
export interface LedgerRowFinding {
  /** Repo-relative ledger path and 1-based line number. */
  readonly where: string
  /** Empty when the row complies; otherwise the required fix. */
  readonly problem: string
}

/**
 * Check the ledger rows between the convention markers. Pure over its input so
 * tests can pin behavior without touching the repository.
 * @param text - the full `PLUGINS.md` content.
 * @returns one finding per non-compliant row; empty when the convention holds.
 */
export function checkLedgerCompat(text: string): LedgerRowFinding[] {
  const start = text.indexOf(START_MARKER)
  if (start < 0) {
    return [{ where: `${LEDGER}:1`, problem: `missing ${START_MARKER}; add the marker around ledger rows recorded under the compat convention.` }]
  }
  const end = text.indexOf(END_MARKER, start)
  if (end < 0) {
    return [{ where: `${LEDGER}:1`, problem: `missing ${END_MARKER}; close the convention region opened by ${START_MARKER}.` }]
  }
  const region = text.slice(start + START_MARKER.length, end)
  const findings: LedgerRowFinding[] = []
  let line = text.slice(0, start).split('\n').length
  for (const row of region.split('\n')) {
    line += 1
    if (!row.startsWith('|') || row.includes('---')) continue
    if (!row.includes('Compat:')) {
      findings.push({ where: `${LEDGER}:${line}`, problem: 'row has no Compat: tail; declare the stance (`Compat: <claim>.` or `Compat: none.`).' })
      continue
    }
    const claim = /Compat:\s*([^.]*)\./.exec(row)?.[1]?.trim()
    if (claim === undefined || claim.length === 0) {
      findings.push({ where: `${LEDGER}:${line}`, problem: 'Compat: tail has no claim sentence.' })
      continue
    }
    if (claim !== 'none' && !row.includes('Verify:')) {
      findings.push({ where: `${LEDGER}:${line}`, problem: `non-none Compat: "${claim}" lacks a Verify: command tail.` })
    }
  }
  return findings
}

/** CLI entry, guarded so importing this module for tests runs no check. */
function main(): void {
  const findings = checkLedgerCompat(readFileSync(resolve(root, LEDGER), 'utf8'))
  if (findings.length > 0) {
    console.error('verify-ledger-compat: PLUGINS.md compat-convention violations:')
    for (const finding of findings) console.error(`  ${finding.where}: ${finding.problem}`)
    process.exit(1)
  }
  console.log('verify-ledger-compat: PLUGINS.md compat convention holds.')
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
