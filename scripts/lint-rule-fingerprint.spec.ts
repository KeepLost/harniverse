import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { flattenDiagnosticMessageText, parseConfigFileTextToJson } from 'typescript'
import { describe, expect, it } from 'vitest'

type Rules = Record<string, unknown>

interface Profile {
  readonly count: number
  readonly indexes: readonly number[]
  readonly sha256: string
}

// A one-time audit against eslint.config.mjs blob 696b08282885296830189fdafe7051a356806fc2
// mapped @typescript-eslint/* to typescript/* and four extension rules to their
// Oxlint core equivalents. These fingerprints pin the resulting repository
// snapshot; they do not re-evaluate that deleted baseline or track its preset.
const profiles = {
  source: {
    count: 89,
    indexes: [0, 1, 4, 5],
    sha256: '1b7f4a38fe4559d9f50b191cbe0af8dff3bfe3727d31bccc4beb3555607d5afd',
  },
  example: {
    count: 88,
    indexes: [0, 1, 2, 4, 5],
    sha256: '0a242e140671e085be53049cee31b9f950df8b51e1e514f4c74f0e1865cf1029',
  },
  test: {
    count: 82,
    indexes: [0, 3, 4, 5],
    sha256: '5b329c7264bbd588818954a06416412264bb893aac7ee6e7cfa442aff3e38b1d',
  },
} as const satisfies Record<string, Profile>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function severity(value: unknown): 0 | 1 | 2 {
  const level = isUnknownArray(value) ? value[0] : value
  if (level === 'off' || level === 0) return 0
  if (level === 'warn' || level === 'warning' || level === 1) return 1
  if (level === 'error' || level === 2) return 2
  throw new Error(`unsupported lint severity: ${JSON.stringify(level)}`)
}

function normalizedRules(rules: Rules): Rules {
  return Object.fromEntries(Object.entries(rules)
    .filter(([, value]) => severity(value) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const options = isUnknownArray(value) ? value.slice(1) : []
      return [name, [severity(value), ...options]]
    }))
}

function mergedRules(overrides: readonly unknown[], indexes: readonly number[]): Rules {
  const merged: Rules = {}
  for (const index of indexes) {
    const override = overrides[index]
    if (!isRecord(override) || !isRecord(override.rules)) {
      throw new Error(`.oxlintrc.json override ${index} must contain a rules object`)
    }
    Object.assign(merged, override.rules)
  }
  return normalizedRules(merged)
}

describe('Oxlint repository rule fingerprint', () => {
  const path = fileURLToPath(new URL('../.oxlintrc.json', import.meta.url))
  const result = parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
  if (result.error !== undefined) {
    throw new Error(flattenDiagnosticMessageText(result.error.messageText, '\n'))
  }
  const parsed: unknown = result.config
  if (!isRecord(parsed) || !Array.isArray(parsed.overrides)) {
    throw new Error('.oxlintrc.json must contain an overrides array')
  }
  const overrides: readonly unknown[] = parsed.overrides

  it('pins every override field', () => {
    expect(overrides).toHaveLength(8)
  })

  it.each(Object.entries(profiles))('pins the %s rule profile', (_name, profile) => {
    const rules = mergedRules(overrides, profile.indexes)
    const fingerprint = createHash('sha256').update(JSON.stringify(rules)).digest('hex')

    expect(Object.keys(rules)).toHaveLength(profile.count)
    expect(fingerprint).toBe(profile.sha256)
  })
})
