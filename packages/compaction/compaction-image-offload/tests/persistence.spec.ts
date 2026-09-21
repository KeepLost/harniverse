/** Durable projection across the real SQLite checkpoint and SessionStore fork paths. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import { OFFLOADED_IMAGE_STUB_TEXT, resolveImageOffloadDecisions } from '@deepseek-ai/dsh-image-offload-policy'
import * as imageOffload from '../src/index.ts'

it('restores pre-window offloads from SQLite and preserves them in a persisted fork', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(imageOffload)
  await ctx.plugin(SqliteSessionPersistence, { path: ':memory:' })
  try {
    const id = SessionId('offload-checkpoint')
    const source = ctx.sessions.prepare(id)
    source.append('turn/start', { turn: 1 })
    const original = source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{
      type: 'image', attachment: { attachmentId: AttachmentId('retained'), mediaType: 'image/png', bytes: 4, width: 1, height: 1 },
    }] }), { surfaceOp: 'append' })
    const text = source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'old context' }] }), { surfaceOp: 'append' })
    source.append('image/offload', { targets: [{ messageSeq: original.seq, imageIndex: 0 }] })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const boundary = source.seq
    source.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'compaction' }, content: [{ type: 'text', text: 'summary' }] }), {
      surfaceOp: { op: 'replace', start: text.seq, end: text.seq }, sourceEventSeqs: [text.seq],
    })
    await ctx.sessionPersistence.create(source.header)
    await ctx.sessionPersistence.append(id, [...source.events])
    using preparation = await ctx.sessionPersistence.prepare(id)
    const restored = preparation.session
    expect(restored.firstResidentSeq).toBe(boundary)
    expect(restored.deriveMessages()).toEqual(source.deriveMessages())
    expect(restored.projectedMessageAt(original.seq)?.content).toEqual([{ type: 'text', text: OFFLOADED_IMAGE_STUB_TEXT }])
    expect(restored.deriveEventMessage(restored.eventAt(original.seq)!)?.content).toEqual(original.data.content)
    const detach = ctx.sessions.enter(restored)
    try {
      const child = ctx.sessions.fork(restored, undefined, SessionId('offload-fork'))
      expect(child.deriveMessages()).toEqual(restored.deriveMessages())
      expect(resolveImageOffloadDecisions(child.events, { setting: 1, pressureCount: 100 })).toEqual([])
      await ctx.sessions.flush(child)
      const inspection = await ctx.sessionPersistence.load(child.id)
      const full = ctx.sessions.prepare(SessionId('full-replay'), { seed: [...inspection.events] })
      expect(full.deriveMessages()).toEqual(child.deriveMessages())
      expect(full.events.filter(event => event.type === 'image/offload')).toHaveLength(1)
      expect(full.deriveEventMessage(full.eventAt(original.seq)!)?.content).toEqual(original.data.content)
    } finally {
      detach()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
