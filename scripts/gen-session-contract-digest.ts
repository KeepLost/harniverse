/**
 * Generate `docs/session-contract-digest.json`: the committed baseline of the
 * v0 session-log contract — the format-version constant, the complete
 * merge-extensible event vocabulary with payload texts, the surface-eligible
 * subset, and a structural hash of each persisted event-envelope declaration.
 * `--check` classifies drift against the committed baseline: structural drift
 * (removed events, changed payloads, changed envelope, changed version) fails
 * as a v0-freeze violation, while additive drift (new event types) fails as
 * stale until the baseline is consciously regenerated with compatibility
 * rationale and verification recorded in the owning Agent Note.
 *
 * All facts are AST-extracted from source, so the gate never depends on built
 * artifacts.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  annotateSurface,
  collectEventEnvelopeTypes,
  collectLogEvents,
  collectSurfaceEventTypes,
} from './gen-persistence-catalog.ts'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/session-contract-digest.json'

/** The owning declaration of the frozen format-version constant. */
const SESSION_TYPES_SOURCE = 'packages/core/session/src/types.ts'

/** The committed digest shape; version bumps only on incompatible changes. */
export interface SessionContractDigest {
  readonly version: 1
  /** Stance marker: only additive changes inside v0 are permitted. */
  readonly policy: 'v0-additive-only'
  readonly sessionFormatVersion: number
  /** Every `SessionEventMap` member declared in this repository, sorted. */
  readonly eventTypes: readonly string[]
  /** The `SurfaceEventType` literal members, sorted. */
  readonly surfaceEventTypes: readonly string[]
  /** Event name to whitespace-collapsed payload type text, sorted by name. */
  readonly eventPayloads: Readonly<Record<string, string>>
  /** Comment-stripped sha256 of each persisted event-envelope declaration. */
  readonly envelope: readonly { readonly name: string; readonly structuralSha256: string }[]
}

/** Drift between a committed baseline and the freshly built digest. */
export interface SessionContractDrift {
  /** Changes the v0 freeze disallows: version, removals, payload or envelope changes. */
  readonly structural: string[]
  /** Permitted changes that still require a conscious baseline refresh. */
  readonly additive: string[]
}

/**
 * Read `SESSION_FORMAT_VERSION` from its owning declaration by AST, not by
 * importing the package: the gate must run without built artifacts and must
 * fail on a non-literal constant rather than silently skipping the fact.
 */
export function readSessionFormatVersion(scanRoot: string = root): number {
  const abs = resolve(scanRoot, SESSION_TYPES_SOURCE)
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true)
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (decl.name.getText(sf) !== 'SESSION_FORMAT_VERSION' || !decl.initializer) continue
      if (ts.isNumericLiteral(decl.initializer)) return Number(decl.initializer.text)
      throw new Error(`gen-session-contract-digest: SESSION_FORMAT_VERSION (${SESSION_TYPES_SOURCE}) is not a numeric literal.`)
    }
  }
  throw new Error(`gen-session-contract-digest: SESSION_FORMAT_VERSION not found in ${SESSION_TYPES_SOURCE}.`)
}

/** Print one declaration without comments, so JSDoc edits never drift the hash. */
function structuralHash(declaration: string): string {
  const sf = ts.createSourceFile('declaration.ts', declaration, ts.ScriptTarget.Latest, true)
  const stmt = sf.statements[0]
  if (!stmt) throw new Error('gen-session-contract-digest: empty envelope declaration.')
  const printed = ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, stmt, sf)
  return createHash('sha256').update(printed).digest('hex')
}

/** Assemble the digest from the AST-collected contract facts. */
export function buildSessionContractDigest(scanRoot: string = root): SessionContractDigest {
  const events = annotateSurface(collectLogEvents(scanRoot), collectSurfaceEventTypes(scanRoot))
  collectEventEnvelopeTypes(scanRoot)
  const sorted = [...events].sort((a, b) => a.name.localeCompare(b.name))
  const eventPayloads: Record<string, string> = {}
  for (const event of sorted) eventPayloads[event.name] = event.payload
  return {
    version: 1,
    policy: 'v0-additive-only',
    sessionFormatVersion: readSessionFormatVersion(scanRoot),
    eventTypes: sorted.map(event => event.name),
    surfaceEventTypes: [...collectSurfaceEventTypes(scanRoot)].sort(),
    eventPayloads,
    envelope: collectEventEnvelopeTypes(scanRoot).map(entry => ({
      name: entry.name,
      structuralSha256: structuralHash(entry.declaration),
    })),
  }
}

/**
 * Classify baseline-to-current drift under the v0 additive-only policy.
 * Pure and total: the caller decides how each bucket fails.
 */
export function diffSessionContractDigest(baseline: SessionContractDigest, current: SessionContractDigest): SessionContractDrift {
  const structural: string[] = []
  const additive: string[] = []
  if (baseline.sessionFormatVersion !== current.sessionFormatVersion) {
    structural.push(`SESSION_FORMAT_VERSION changed ${baseline.sessionFormatVersion} -> ${current.sessionFormatVersion}; the format is permanently frozen at v0.`)
  }
  const baselineTypes = new Set(baseline.eventTypes)
  const currentTypes = new Set(current.eventTypes)
  for (const name of baseline.eventTypes) {
    if (!currentTypes.has(name)) structural.push(`event type '${name}' was removed.`)
  }
  for (const name of current.eventTypes) {
    if (!baselineTypes.has(name)) additive.push(`event type '${name}' was added.`)
  }
  for (const name of baseline.eventTypes) {
    const before = baseline.eventPayloads[name]
    const after = current.eventPayloads[name]
    if (before !== undefined && after !== undefined && before !== after) {
      structural.push(`payload of event '${name}' changed:\n  - ${before}\n  + ${after}`)
    }
  }
  for (const name of baseline.surfaceEventTypes) {
    if (!current.surfaceEventTypes.includes(name)) structural.push(`surface event type '${name}' was removed.`)
  }
  for (const name of current.surfaceEventTypes) {
    if (!baseline.surfaceEventTypes.includes(name)) additive.push(`surface event type '${name}' was added.`)
  }
  if (baseline.envelope.length !== current.envelope.length) {
    structural.push('event-envelope declaration set changed size.')
  }
  for (const entry of baseline.envelope) {
    const after = current.envelope.find(candidate => candidate.name === entry.name)
    if (after === undefined) structural.push(`event-envelope declaration '${entry.name}' was removed.`)
    else if (after.structuralSha256 !== entry.structuralSha256) {
      structural.push(`event-envelope declaration '${entry.name}' changed structurally.`)
    }
  }
  return { structural, additive }
}

/** Parse and validate the committed baseline file's digest shape. */
export function parseSessionContractDigest(text: string): SessionContractDigest {
  const parsed = JSON.parse(text) as Partial<SessionContractDigest>
  const shapeInvalid = parsed.version !== 1 || parsed.policy !== 'v0-additive-only' || typeof parsed.sessionFormatVersion !== 'number'
    || !Array.isArray(parsed.eventTypes) || !Array.isArray(parsed.surfaceEventTypes)
    || !parsed.eventPayloads || typeof parsed.eventPayloads !== 'object' || !Array.isArray(parsed.envelope)
  if (shapeInvalid) {
    throw new Error('gen-session-contract-digest: committed baseline is not a v1 v0-additive-only digest.')
  }
  return parsed as SessionContractDigest
}

/** CLI entry: default writes the baseline, `--check` classifies drift. */
function main(): void {
  const rendered = `${JSON.stringify(buildSessionContractDigest(), null, 2)}\n`
  const target = resolve(root, OUT)
  if (!process.argv.includes('--check')) {
    writeFileSync(target, rendered)
    console.log(`gen-session-contract-digest: wrote ${OUT}.`)
    return
  }
  let current: string
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    console.error(`gen-session-contract-digest: ${OUT} is missing; run \`pnpm run gen-session-contract-digest\` and commit it.`)
    process.exit(1)
  }
  if (current === rendered) {
    console.log('gen-session-contract-digest: docs/session-contract-digest.json is up to date.')
    return
  }
  const drift = diffSessionContractDigest(parseSessionContractDigest(current), buildSessionContractDigest())
  if (drift.structural.length > 0) {
    console.error('gen-session-contract-digest: STRUCTURAL session-contract drift — the permanent v0 freeze disallows it:')
    for (const item of drift.structural) console.error(`  - ${item}`)
    console.error('A structural breaking change is policy-disallowed. If a listed change is genuinely additive (for example a new optional envelope field), record the compatibility rationale and verification in the owning Agent Note before consciously regenerating the baseline in the same change.')
    process.exit(1)
  }
  console.error('gen-session-contract-digest: additive session-contract drift detected:')
  for (const item of drift.additive) console.error(`  - ${item}`)
  console.error('Record the additive compatibility rationale and verification in the owning Agent Note, then run `pnpm run gen-session-contract-digest` and include the baseline refresh in the same change.')
  process.exit(1)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
