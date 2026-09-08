import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ContextSnapshotInvariant from '@deepseek-ai/dsh-context-snapshot/invariant'

const SOURCE = '@deepseek-ai/dsh-context-snapshot'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ContextSnapshotInvariant)
  return ctx
}

function snapshotMessage(
  sections: readonly { name: string; text: string }[],
  partial: boolean,
) {
  return createUserMessage({
    content: [{ type: 'text', text: 'Current runtime context.' }],
    source: {
      kind: 'plugin',
      plugin: SOURCE,
      form: 'snapshot',
      ...partial ? { partial: true } : {},
      sections,
    },
  })
}

/** One seeded compaction replacement shadowing `seq`. */
function shadowSeed(seq: number, shadowed: number) {
  return {
    type: 'user/message' as const,
    seq,
    time: 0,
    data: createUserMessage({
      content: [{ type: 'text', text: 'compacted summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }),
    surfaceOp: { op: 'replace' as const, start: shadowed, end: shadowed },
    sourceEventSeqs: [shadowed],
  }
}

describe('context-snapshot invariants', () => {
  it('accepts a partial snapshot that follows a visible complete record', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('context-invariant-valid'))
    session.append('user/message', snapshotMessage([{ name: 'policy', text: 'read-only' }], false), { surfaceOp: 'append' })
    expect(() => {
      session.append('user/message', snapshotMessage([{ name: 'policy', text: 'full-access' }], true), { surfaceOp: 'append' })
    }).not.toThrow()
  })

  it('accepts a cleared marker as the preceding usable record', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('context-invariant-cleared'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: CLEARED }],
      source: { kind: 'plugin', plugin: SOURCE },
    }), { surfaceOp: 'append' })
    expect(() => {
      session.append('user/message', snapshotMessage([{ name: 'policy', text: 'read-only' }], true), { surfaceOp: 'append' })
    }).not.toThrow()
  })

  it('rejects a visible partial with no visible usable record before it', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.sessions.create(SessionId('context-invariant-partial-first'), {
        seed: [
          { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
          {
            type: 'user/message',
            seq: 1,
            time: 0,
            data: createUserMessage({
              content: [{ type: 'text', text: 'notice' }],
              source: { kind: 'plugin', plugin: SOURCE, form: 'notice', summary: 'notice' },
            }),
            surfaceOp: 'append',
          },
          {
            type: 'user/message',
            seq: 2,
            time: 0,
            data: createUserMessage({
              content: [{ type: 'text', text: 'foreign' }],
              source: { kind: 'plugin', plugin: 'foreign-plugin', form: 'snapshot', partial: true, sections: [] },
            } as never),
            surfaceOp: 'append',
          },
          {
            type: 'user/message',
            seq: 3,
            time: 0,
            data: createUserMessage({
              content: [{ type: 'text', text: 'broken' }, { type: 'text', text: 'snapshot' }],
              source: { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections: 'not-a-list' },
            } as never),
            surfaceOp: 'append',
          },
          {
            type: 'user/message',
            seq: 4,
            time: 0,
            data: snapshotMessage([{ name: 'policy', text: 'read-only' }], true),
            surfaceOp: 'append',
          },
        ],
      })
    }).toThrow(/must follow a visible usable owned record/)
    expect(ctx.sessions.get(SessionId('context-invariant-partial-first'))).toBeUndefined()
  })

  it('accepts a session whose unusable and shadowed records never carried the state', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('context-invariant-shadowed-history'), {
      seed: [
        { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
        {
          type: 'user/message',
          seq: 1,
          time: 0,
          data: snapshotMessage([{ name: 'policy', text: 'read-only' }], false),
          surfaceOp: 'append',
        },
        {
          type: 'user/message',
          seq: 2,
          time: 0,
          data: snapshotMessage([{ name: 'policy', text: 'full-access' }], true),
          surfaceOp: 'append',
        },
        shadowSeed(3, 2),
        {
          type: 'user/message',
          seq: 4,
          time: 0,
          data: snapshotMessage([{ name: 'policy', text: 'read-only' }], false),
          surfaceOp: 'append',
        },
        shadowSeed(5, 4),
      ],
    })
    expect([...session.surface.nodes]).toContain(1)
    expect([...session.surface.nodes]).not.toContain(2)
    expect([...session.surface.nodes]).not.toContain(4)
  })

  it('rejects a partial whose preceding complete record was shadowed', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('context-invariant-shadowed'))
    const complete = session.append('user/message', snapshotMessage([{ name: 'policy', text: 'read-only' }], false), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: complete.seq, end: complete.seq },
      sourceEventSeqs: [complete.seq],
    })
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'user/message',
        seq: complete.seq + 2,
        time: 0,
        data: snapshotMessage([{ name: 'policy', text: 'full-access' }], true),
      } as never)
    }).toThrow(/must follow a visible usable owned record/)
  })

  it('ignores malformed owned records and foreign partials', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('context-invariant-malformed'))
    for (const source of [
      { kind: 'plugin', plugin: SOURCE },
      { kind: 'plugin', plugin: SOURCE, form: 'notice', summary: 'notice' },
      { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections: 'not-a-list' },
      { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections: [{ name: '', text: 'x' }] },
      { kind: 'plugin', plugin: 'foreign-plugin', form: 'snapshot', partial: true, sections: [{ name: 'other', text: 'x' }] },
    ] as const) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'unreadable' }],
        source: source as never,
      }), { surfaceOp: 'append' })
    }
    expect(() => {
      session.append('user/message', snapshotMessage([{ name: 'policy', text: 'read-only' }], false), { surfaceOp: 'append' })
    }).not.toThrow()
  })

  it('rejects an invalid existing partial on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('context-invariant-late-invalid'))
    session.append('user/message', snapshotMessage([{ name: 'policy', text: 'read-only' }], true), { surfaceOp: 'append' })

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(ContextSnapshotInvariant).then(() => undefined))
      .rejects.toThrow(/must follow a visible usable owned record/)
  })
})
