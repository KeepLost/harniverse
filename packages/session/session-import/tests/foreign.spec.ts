import { describe, expect, it } from 'vitest'
import { ForeignLogError, parseForeignSessionLog } from '../src/foreign.ts'

const header = { type: 'session', version: 3, id: 'foreign', createdAt: 0, delegationDepth: 0, isSeeded: false }
const event = { seq: 0, type: 'turn/start', time: 0, data: { turn: 1 } }
const artifact = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n')

describe('foreign JSONL framing', () => {
  it.each(['null', 'false', '[]', '"header"'])('rejects a non-object header %s', (text) => {
    expect(() => parseForeignSessionLog(text)).toThrow('header must be a JSON object')
  })

  it.each([
    { type: 'other' }, { id: '' }, { id: 1 }, { createdAt: -1 }, { createdAt: 0.5 },
    { createdAt: '0' }, { delegationDepth: -1 }, { cwd: null }, { isSeeded: 'false' },
  ])('rejects invalid header fields %j', (patch) => {
    expect(() => parseForeignSessionLog(artifact({ ...header, ...patch }))).toThrow('invalid foreign session header')
  })

  it('identifies invalid JSON in an event separately from the header', () => {
    expect(() => parseForeignSessionLog(artifact(header) + '\n{broken')).toThrow('event line 2 is not valid JSON')
  })

  it.each([null, [], false, 'event'])('rejects non-object event %j', (row) => {
    expect(() => parseForeignSessionLog(artifact(header, row))).toThrow('event line 2 must be a JSON object')
  })

  it.each([{ type: '' }, { type: 1 }, { time: 0.5 }, { data: null }, { data: [] }, { data: 'payload' }])(
    'rejects invalid event envelope %j', (patch) => {
      expect(() => parseForeignSessionLog(artifact(header, { ...event, ...patch }))).toThrow('invalid foreign event envelope')
    },
  )

  it.each([2, 3])('refuses packed chunks in v%i', (version) => {
    expect(() => parseForeignSessionLog(artifact({ ...header, version }, { type: 'text-chunks' }))).toThrow('packed chunk rows require official v1')
  })

  it('reports malformed v1 packed chunks', () => {
    expect(() => parseForeignSessionLog(artifact({ ...header, version: 1 }, { type: 'text-chunks', data: {} }))).toThrow('invalid packed row')
  })

  it.each([
    'replace', [], null, { op: 'append' }, { op: 'replace', startSeq: -1, endSeq: 0 },
    { op: 'replace', startSeq: 0, endSeq: -1 }, { op: 'replace', startSeq: 1, endSeq: 0 },
    { op: 'replace', startSeq: 0, endSeq: 1 },
  ])('refuses invalid surface replacement %j', (surfaceOp) => {
    expect(() => parseForeignSessionLog(artifact(header, event, { ...event, seq: 1, surfaceOp }))).toThrow('invalid foreign surface replacement')
  })

  it.each(['user/message', 'assistant/message', 'tool/result', 'system/message'])('requires a surface operation for %s', (type) => {
    expect(() => parseForeignSessionLog(artifact(header, { ...event, type }))).toThrow('foreign message requires surfaceOp')
  })

  it.each(['0', [[0]], [[-1, 0]], [[0, -1]], [[1, 0]], [1]])('rejects invalid provenance %j', (sourceEventSeqs) => {
    expect(() => parseForeignSessionLog(artifact(header, event, { ...event, seq: 1, sourceEventSeqs }))).toThrow(ForeignLogError)
  })

  it.each([1, 2, 3])('normalizes v%i replacements and preserves valid provenance framing', (version) => {
    const surfaceOp = version === 3 ? { op: 'replace', startSeq: 0, endSeq: 0 } : { op: 'replace', start: 0, end: 0 }
    const parsed = parseForeignSessionLog('\n' + artifact({ ...header, version }, event,
      { ...event, seq: 1, surfaceOp, sourceEventSeqs: [0, [0, 0]] }) + '\n\n')
    expect(parsed.header).toEqual({ id: 'foreign', version, createdAt: 0, cwd: undefined })
    expect(parsed.events).toEqual([event, { ...event, seq: 1, surfaceOp: { op: 'replace', start: 0, end: 0 } }])
  })
})
