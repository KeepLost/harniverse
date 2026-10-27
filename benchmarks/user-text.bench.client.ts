/** Credential-matching cost over representative sent-user-text documents. */

import { performance } from 'node:perf_hooks'
import { CredentialScanner, formatTables } from '@deepseek-ai/dsh-client-ui-secret-mask/client'
import { afterAll, beforeAll, expect, it } from 'vitest'
/** Median of the samples; inline because the shared support tree belongs to the host aggregate. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

/** Three-decimal rounding, matching the shared support helpers' report shape. */
function rounded(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const SAMPLES = 5

/** Documents without credentials: the common case, so the unmatched path dominates. */
const UNMATCHED_DOCUMENTS: Readonly<Record<string, () => string>> = {
  'typical-messages': () => Array.from({ length: 200 }, (_unused, index) =>
    `消息 ${String(index)}：请帮我看下这个模块的实现，顺便解释一下返回值的结构。`).join('\n'),
  'prose-256k': () => 'The harness keeps its web access behind one capability seam. '.repeat(2_800),
  'code-256k': () => 'export function computeOffset(index: number): number { return index * 2 + 1 }\n'.repeat(2_300),
  'json-256k': () => JSON.stringify(Array.from({ length: 1_600 }, (_unused, index) => ({ seq: index, type: 'user/message', text: `消息 ${String(index)}` }))),
  'base64-256k': () => 'ABCDEFGHIJKLMNOPabcdefghijklmnop0123456789+/'.repeat(4_300),
}

/** Documents the matcher masks: the worst realistic shape is one credential per short message. */
const MATCHED_DOCUMENTS: Readonly<Record<string, () => string>> = {
  'messages-with-model-key': () => Array.from({ length: 200 }, (_unused, index) =>
    `第 ${String(index)} 条：密钥 sk-0123456789abcdefghijklmnopqrstuv 请保管好。`).join('\n'),
  'messages-with-github-token': () => Array.from({ length: 200 }, (_unused, index) =>
    `第 ${String(index)} 条：令牌 ghp_${'0123456789'.repeat(4)}AbCdEf 请勿外发。`).join('\n'),
}

interface Sample {
  readonly document: string
  readonly durationMs: number
  readonly matches: number
}

/** Scan one document to its end through repeated advancing-offset queries. */
function scan(scanner: CredentialScanner, text: string): number {
  let matches = 0
  let from = 0
  while (from <= text.length) {
    const match = scanner.match(text, from)
    if (match === undefined) break
    matches++
    from = Math.max(match.end, match.start + 1)
  }
  return matches
}

let started = false
beforeAll(() => {
  // One warm-up scan per document shape tiers the JIT before the measured samples.
  for (const build of [...Object.values(UNMATCHED_DOCUMENTS), ...Object.values(MATCHED_DOCUMENTS)]) {
    scan(new CredentialScanner(formatTables()), build().slice(0, 4_096))
  }
  started = true
})

afterAll(() => {
  if (!started) throw new Error('user-text benchmark did not run its samples')
})

it('keeps credential scanning of representative user text within its budgets', () => {
  const samples: Sample[] = []
  for (const [document, build] of Object.entries({ ...UNMATCHED_DOCUMENTS, ...MATCHED_DOCUMENTS })) {
    const text = build()
    for (let index = 0; index < SAMPLES; index += 1) {
      const scanner = new CredentialScanner(formatTables())
      const startedAt = performance.now()
      const matches = scan(scanner, text)
      samples.push({ document, durationMs: performance.now() - startedAt, matches })
    }
  }

  const perDocument = new Map<string, { durations: number[]; matches: number }>()
  for (const sample of samples) {
    const entry = perDocument.get(sample.document) ?? { durations: [], matches: sample.matches }
    entry.durations.push(sample.durationMs)
    perDocument.set(sample.document, entry)
  }
  const aggregate = [...perDocument.entries()]
    .map(([document, entry]) => ({ document, medianMs: rounded(median(entry.durations)), matches: entry.matches }))
    .sort((left, right) => left.document.localeCompare(right.document))

  // Reference budgets: measured medians stay under 1 ms per ~256 KiB document
  // on the reference machine; a 10 ms ceiling holds variance headroom while a
  // backtracking regression (the failure mode this gate exists for) crosses it
  // by orders of magnitude.
  const BUDGET_MS_PER_DOCUMENT = 10
  const report = {
    benchmark: 'user-text',
    workload: {
      samples: SAMPLES,
      unmatchedDocuments: Object.keys(UNMATCHED_DOCUMENTS).length,
      matchedDocuments: Object.keys(MATCHED_DOCUMENTS).length,
    },
    aggregate,
    budgets: { perDocumentMs: BUDGET_MS_PER_DOCUMENT },
  }
  process.stdout.write(`HARNIVERSE_BENCHMARK_RESULT ${JSON.stringify(report)}\n`)

  expect(aggregate.every(entry => entry.medianMs <= BUDGET_MS_PER_DOCUMENT)).toBe(true)
  const modelKey = aggregate.find(entry => entry.document === 'messages-with-model-key')
  const githubToken = aggregate.find(entry => entry.document === 'messages-with-github-token')
  expect(modelKey?.matches).toBe(200)
  expect(githubToken?.matches).toBe(200)
  expect(aggregate.find(entry => entry.document === 'typical-messages')?.matches).toBe(0)
}, 120_000)
