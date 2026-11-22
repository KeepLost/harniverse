import { expect, it } from 'vitest'
import { OutputLedger } from '../src/output-ledger.ts'

it('accounts for exact JSON escaping, separators and optional completion values', () => {
  const ledger = new OutputLedger(20)
  const logs: string[] = []
  expect(ledger.admit('first', logs)).toBe(true)
  expect(ledger.admit('second', logs)).toBe(true)
  expect(ledger.admit('third', logs)).toBe(false)
  expect(ledger.success(logs)).toEqual({ logs: ['first', 'second'] })
  expect(ledger.success(logs, 1)).toEqual({ logs: ['first', 'second'], value: 1 })
})

it('prioritizes the required completion value over the retained log prefix', () => {
  const ledger = new OutputLedger(20)
  const logs: string[] = []
  expect(ledger.admit('first', logs)).toBe(true)
  expect(ledger.admit('second', logs)).toBe(true)
  const cut = ledger.success(logs, 'late-value')
  expect(cut).toEqual({ logs: ['fi'], value: 'late-value', outputTruncated: true })
  // An early entry survives the cut while a later one is dropped whole.
  const stepped = new OutputLedger(20)
  const steppedLogs: string[] = []
  expect(stepped.admit('a', steppedLogs)).toBe(true)
  expect(stepped.admit('b', steppedLogs)).toBe(true)
  expect(stepped.success(steppedLogs, 'v'.repeat(11))).toEqual({
    logs: ['a'],
    value: 'v'.repeat(11),
    outputTruncated: true,
  })

  const impossible = ledger.success(logs, 'v'.repeat(100))
  expect(impossible.error?.kind).toBe('output-limit')
  expect(impossible.outputTruncated).toBe(true)
})

it('keeps a fitting log prefix when an overflowing entry arrives', () => {
  const ledger = new OutputLedger(20)
  const logs: string[] = []
  expect(ledger.admit('first', logs)).toBe(true)
  ledger.admitPrefix('second-third', logs)
  expect(logs).toEqual(['first', 'second-t'])

  const exhausted = new OutputLedger(8)
  const exhaustedLogs: string[] = []
  expect(exhausted.admit('abcd', exhaustedLogs)).toBe(true)
  exhausted.admitPrefix('zz', exhaustedLogs)
  expect(exhaustedLogs).toEqual(['abcd'])
})

it('bounds a failure diagnostic without reclassifying its kind', () => {
  const ledger = new OutputLedger(20)
  expect(ledger.failure([], { kind: 'exception', message: 'short' })).toEqual({ logs: [], error: { kind: 'exception', message: 'short' } })
  const huge = ledger.failure([], { kind: 'exception', message: 'x'.repeat(100) })
  expect(huge.error?.kind).toBe('exception')
  expect(huge.outputTruncated).toBe(true)
  expect(huge.error?.message.length).toBeLessThan(100)

  const beside = new OutputLedger(20)
  const logs: string[] = []
  expect(beside.admit('first-entry', logs)).toBe(true)
  const squeezed = beside.failure(logs, { kind: 'worker-exit', message: 'y'.repeat(30) })
  expect(squeezed.error?.kind).toBe('worker-exit')
  expect(squeezed.outputTruncated).toBe(true)
  const bytes = Buffer.byteLength(JSON.stringify(squeezed.logs)) + Buffer.byteLength(JSON.stringify(squeezed.error?.message))
  expect(bytes).toBeLessThanOrEqual(20)
})

it('retains a bounded prefix when a required value exceeds the limit', () => {
  for (const maxBytes of [4, 8, 40, 80]) {
    const ledger = new OutputLedger(maxBytes)
    const result = ledger.limit(['a', 'b', '你好🙂'.repeat(50)])
    expect(result.error?.kind).toBe('output-limit')
    expect(result.outputTruncated).toBe(true)
    const bytes = Buffer.byteLength(JSON.stringify(result.logs)) + Buffer.byteLength(JSON.stringify(result.error?.message))
    expect(bytes).toBeLessThanOrEqual(maxBytes)
  }
})
