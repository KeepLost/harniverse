import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import * as SessionImportInvariant from '@deepseek-ai/dsh-session-import/invariant'
import type { ImportRecordEventData } from '@deepseek-ai/dsh-session-import'

async function setup(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(SessionImportInvariant)
  return { ctx, session: ctx.sessions.create() }
}

function record(format: ImportRecordEventData['source']['format'], artifactName: string, supervisionMode = 'supervised'): ImportRecordEventData {
  return { source: { format, artifactName }, posture: { supervisionMode: supervisionMode as ImportRecordEventData['posture']['supervisionMode'] } }
}

describe('session-import invariants', () => {
  it('accepts a well-formed marker as the first event', async () => {
    const { session } = await setup()
    expect(() => session.append('import/record', record('official-v3', 'source.jsonl'))).not.toThrow()
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
  })

  it('rejects a marker that is not the first event or appears twice', async () => {
    const { session } = await setup()
    session.append('turn/start', { turn: 1 })
    expect(() => session.append('import/record', record('official-v1', 'a.jsonl')))
      .toThrow(new InvariantError('@deepseek-ai/dsh-session-import', 'import/record must be the first event of its session; imported history follows the marker'))
    const fresh = await setup()
    fresh.session.append('import/record', record('official-v1', 'a.jsonl'))
    expect(() => fresh.session.append('import/record', record('official-v1', 'a.jsonl')))
      .toThrow(new InvariantError('@deepseek-ai/dsh-session-import', 'import/record must be the first event of its session; imported history follows the marker'))
  })

  it('rejects unclassified formats, empty artifact names, and unknown modes', async () => {
    const { session } = await setup()
    expect(() => session.append('import/record', record('current' as never, 'a.jsonl')))
      .toThrow(/must name a classified foreign generation/)
    expect(() => session.append('import/record', record('official-v3', '')))
      .toThrow(/artifactName must be a non-empty string/)
    expect(() => session.append('import/record', record('official-v3', 'a.jsonl', 'sometimes')))
      .toThrow(/posture\.supervisionMode must be one of/)
  })

  it('rejects a misplaced marker already present when the companion registers late', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('import/record', record('official-v1', 'a.jsonl'))
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(SessionImportInvariant).then(() => undefined)).rejects.toMatchObject({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-session-import',
    })
  })

  it('ignores unrelated appends', async () => {
    const { session } = await setup()
    expect(() => session.append('turn/start', { turn: 1 })).not.toThrow()
  })
})
