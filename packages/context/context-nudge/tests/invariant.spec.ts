import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Invariants from '@deepseek-ai/dsh-invariants'
import SessionStore from '@deepseek-ai/dsh-session'
import * as ContextNudgeInvariant from '@deepseek-ai/dsh-context-nudge/invariant'

const SOURCE = '@deepseek-ai/dsh-context-nudge'

/** An owned notice event with the given recorded measurement pair. */
describe('context-nudge invariant', () => {
  it('accepts a notice whose measurement met its threshold', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Invariants)
    await ctx.plugin(ContextNudgeInvariant)
    const session = ctx.sessions.create(SessionId('invariant-valid'))
    expect(() => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'notice' }],
        source: { kind: 'plugin', plugin: SOURCE, form: 'system-injection', measuredTokens: 200, thresholdTokens: 64 },
      }), { surfaceOp: 'append' })
    }).not.toThrow()
  })

  it('rejects a notice recorded below its threshold', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Invariants)
    await ctx.plugin(ContextNudgeInvariant)
    const session = ctx.sessions.create(SessionId('invariant-invalid'))
    expect(() => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'notice' }],
        source: { kind: 'plugin', plugin: SOURCE, form: 'system-injection', measuredTokens: 10, thresholdTokens: 64 },
      }), { surfaceOp: 'append' })
    }).toThrow(/at or above its threshold/)
  })
})
