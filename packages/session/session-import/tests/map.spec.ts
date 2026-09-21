import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ForeignLogError, mapForeignSessionEvents, parseForeignSessionLog, scheduleImportEvents } from '../src/index.ts'
import { FOREIGN_TEXT, officialArtifact } from './import-fixture.ts'

const marker = { type: 'import/record', time: 1, data: { source: { format: 'official-v3', artifactName: 'source.jsonl' }, posture: { supervisionMode: 'supervised' } } } as const
const map = (text: string) => mapForeignSessionEvents(parseForeignSessionLog(text), 1)
function mutate(edit: (records: Record<string, unknown>[]) => void): string {
  // Foreign fixtures deliberately model an untrusted JSON boundary.
  const records = FOREIGN_TEXT.split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  edit(records)
  return records.map((record: unknown) => JSON.stringify(record)).join('\n')
}

describe('official foreign parsing and native display mapping', () => {
  it('refuses a normalized snapshot with omitted physical packed envelopes', async () => {
    const raw = await readFile(new URL('fixtures/official-v1.jsonl', import.meta.url), 'utf8')
    expect(() => parseForeignSessionLog(raw)).toThrow(ForeignLogError)
  })

  it.each(['seq', 'time'])('refuses official v1 scalar rows without %s', async (key) => {
    const lines = (await officialArtifact(1)).split('\n')
    const row = JSON.parse(lines[1]!) as Record<string, unknown>
    if (key === 'seq') delete row.seq
    else delete row.time
    lines[1] = JSON.stringify(row)
    expect(() => parseForeignSessionLog(lines.join('\n'))).toThrow(ForeignLogError)
  })

  it.each([1, 2, 3] as const)('maps official v%i recordings with no foreign control events', async (version) => {
    const log = parseForeignSessionLog(await officialArtifact(version))
    const mapped = mapForeignSessionEvents(log, 1)
    expect(mapped.skipped).toBeGreaterThan(0)
    const session = Session.create(SessionId(`v${version}`), scheduleImportEvents(marker, mapped.events))
    expect(JSON.stringify(session.deriveMessages())).toContain(version === 1 ? 'PONG' : 'dsh-sdk-proof-7391')
    expect(mapped.events.some(event => event.type.startsWith('agent/inbox'))).toBe(false)
    expect(mapped.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    if (version === 1) {
      expect(log.events.filter(event => event.type === 'assistant/chunk').length).toBeGreaterThan(20)
      expect(mapped.events.some(event => event.type === 'assistant/chunk')).toBe(false)
    }
  })

  it('closes a missing step boundary and interrupted turns before the synthetic origin tail', () => {
    expect(map(FOREIGN_TEXT).events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end',
    ])
    const incomplete = FOREIGN_TEXT.split('\n').slice(0, 7).join('\n')
    expect(map(incomplete).events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } })
  })

  it.each([
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'error', error: { message: 'provider failed', code: 'AUTH' } },
  ])('preserves a settled $kind turn', (reason) => {
    const result = map(mutate((rows) => { (rows[7]!.data as Record<string, unknown>).reason = reason }))
    expect(result.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason } })
  })

  it('remaps v3 tool-result replacements without nesting results or duplicating identities', () => {
    const text = mutate((rows) => {
      const replacement = structuredClone(rows[6]!)
      replacement.seq = 6
      replacement.surfaceOp = { op: 'replace', startSeq: 5, endSeq: 5 }
      replacement.sourceEventSeqs = [5]
      const data = replacement.data as { message: { content: { content: { text: string }[] }[] } }
      data.message.content[0]!.content[0]!.text = 'rewritten'
      rows.splice(7, 0, replacement)
      rows.slice(8).forEach((row) => { row.seq = (row.seq as number) + 1 })
    })
    const mapped = map(text)
    const messages = Session.create(SessionId('replacement'), scheduleImportEvents(marker, mapped.events)).deriveMessages()
    const results = messages.filter(message => message.source.kind === 'tool')
    expect(results).toHaveLength(1)
    expect(results[0]!.content).toEqual([{ type: 'tool-result', toolCallId: 'call-7', content: [{ type: 'text', text: 'rewritten' }], isError: false }])
  })

  it('keeps unsupported blocks visibly lossy and plugin messages attributed to plugins', () => {
    const mapped = map(mutate((rows) => {
      const data = rows[2]!.data as { source: unknown; content: unknown[] }
      data.source = { kind: 'plugin', plugin: 'foreign-context' }
      data.content.push({ type: 'image', url: 'file:///secret' })
    }))
    expect(mapped.events[1]).toMatchObject({ data: { source: { kind: 'plugin', plugin: 'foreign-context' }, content: [
      { type: 'text', text: 'Summarize the repo.' }, { type: 'text', text: '[imported image block omitted]' },
    ] } })
  })

  it.each([
    '', '{oops', '[]', '{"version":3}',
    mutate((rows) => { rows[1]!.seq = 7 }),
    mutate((rows) => { delete rows[1]!.time }),
    mutate((rows) => { rows[2]!.surfaceOp = null }),
    mutate((rows) => { rows[2]!.sourceEventSeqs = [[5, 4]] }),
    mutate((rows) => { (rows[6]!.data as { message: { source: { callId: string } } }).message.source.callId = 'wrong' }),
    mutate((rows) => { (rows[3]!.data as Record<string, unknown>).step = 4 }),
    mutate((rows) => { (rows[2]!.data as Record<string, unknown>).content = 'not an array' }),
  ])('refuses malformed foreign input %#', (text) => {
    expect(() => map(text)).toThrow(ForeignLogError)
  })
})
