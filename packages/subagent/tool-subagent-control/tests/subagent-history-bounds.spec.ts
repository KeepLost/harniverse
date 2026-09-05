/**
 * subagent_history bounds and residency paths: default page size, invalid
 * bounds, live-child reads without persistence, and caller requirements.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** Mount only the tool registry plus stub subagent/session services. */
async function stubSetup(over: {
  sessions?: object
  persistence?: object
}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('subagents', {
    listDescendants: async () => [{
      kind: 'child',
      id: SessionId('child-1'),
      mode: 'one-shot',
      activity: 'running',
      hasChildren: false,
      parentId: SessionId('parent'),
      depth: 1,
    }],
  } as never)
  if (over.sessions !== undefined) ctx.provide('sessions', over.sessions as never)
  if (over.persistence !== undefined) ctx.provide('sessionPersistence', over.persistence as never)
  await ctx.plugin(tool)
  return ctx
}

const parent = { id: SessionId('parent') } as unknown as Agent

let calls = 0
function callHistory(ctx: Context, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`history-${++calls}`),
    name: 'subagent_history',
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('subagent_history bounds and residency', () => {
  it('defaults to the maximum page size and omits the cursor when history fits', async () => {
    const live = {
      header: { parentSession: SessionId('parent') },
      events: [
        { seq: 0, time: '2026-01-01T00:00:00.000Z', type: 'subagent/descriptor', data: { version: 3, mode: 'one-shot', provider: 'spawn', label: 'child' } },
        { seq: 1, time: '2026-01-01T00:00:01.000Z', type: 'user/message', data: { source: { kind: 'user', form: 'text' }, content: [{ type: 'text', text: 'hello' }] } },
      ],
    }
    const ctx = await stubSetup({
      sessions: { get: () => live },
      persistence: { readRawEventPage: () => { throw new Error('live children never page through persistence') } },
    })

    const result = await callHistory(ctx, { subagent_id: 'child-1' }, parent)

    expect(result.isError, text(result)).toBe(false)
    const page = JSON.parse(text(result)) as {
      parent_session_id: string
      events: unknown[]
      has_more: boolean
      next_before_seq?: number
    }
    expect(page.parent_session_id).toBe('parent')
    expect(page.events).toHaveLength(2)
    expect(page.has_more).toBe(false)
    expect(page).not.toHaveProperty('next_before_seq')
  })

  it('requires session persistence even for a known descendant', async () => {
    const ctx = await stubSetup({ sessions: { get: () => undefined } })

    const result = await callHistory(ctx, { subagent_id: 'child-1', max_events: 5 }, parent)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent history requires SessionStore and session persistence')
  })

  it('rejects max_events outside the 1-50 window', async () => {
    const ctx = await stubSetup({ sessions: { get: () => undefined } })
    for (const max_events of [0, 51]) {
      const result = await callHistory(ctx, { subagent_id: 'child-1', max_events }, parent)
      expect(result.isError, `max_events=${max_events}`).toBe(true)
      expect(text(result)).toContain('max_events must be between 1 and 50')
    }
  })

  it('rejects a negative before_seq cursor', async () => {
    const ctx = await stubSetup({
      sessions: { get: () => undefined },
      persistence: { readRawEventPage: () => { throw new Error('must not read') } },
    })

    const result = await callHistory(ctx, { subagent_id: 'child-1', before_seq: -1, max_events: 5 }, parent)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('before_seq must be a non-negative safe integer')
  })

  it('is concurrency-safe and fails loud without a calling agent', async () => {
    const ctx = await stubSetup({})
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: CallId('history-mode'),
      name: 'subagent_history',
      arguments: { subagent_id: 'child-1' },
    })).toEqual({ kind: 'parallel' })

    const result = await callHistory(ctx, { subagent_id: 'child-1' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent_history requires a calling agent')
  })
})
