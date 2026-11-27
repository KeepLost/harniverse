import { describe, expect, it } from 'vitest'
import {
  isRecord,
  normalizeUpdate,
  parseSessionUpdate,
  toStopReason,
  toWorkState,
} from '../src/update.ts'

describe('normalizeUpdate', () => {
  it('keeps streamed text as a message chunk and passes non-text content through untouched', () => {
    expect(normalizeUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }))
      .toEqual({ kind: 'message-chunk', content: { type: 'text', text: 'hi' } })
    const image = { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAA', mimeType: 'image/png' } }
    expect(normalizeUpdate(image)).toEqual({ kind: 'message-chunk', content: image.content })
    expect(normalizeUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }))
      .toEqual({ kind: 'thought-chunk', content: { type: 'text', text: 'thinking' } })
  })

  it('reads whole-message upserts and refuses ones whose content is not a block array', () => {
    expect(normalizeUpdate({ sessionUpdate: 'agent_message', content: [{ type: 'text', text: 'done' }] }))
      .toEqual({ kind: 'message', content: [{ type: 'text', text: 'done' }] })
    expect(normalizeUpdate({ sessionUpdate: 'agent_thought', content: [] })).toEqual({ kind: 'thought', content: [] })
    expect(normalizeUpdate({ sessionUpdate: 'agent_message', content: 'done' }))
      .toEqual({ kind: 'other', sessionUpdate: 'agent_message', update: { sessionUpdate: 'agent_message', content: 'done' } })
    expect(normalizeUpdate({ sessionUpdate: 'agent_message', content: ['done'] }).kind).toBe('other')
  })

  it('maps a malformed chunk to other instead of failing', () => {
    expect(normalizeUpdate({ sessionUpdate: 'agent_message_chunk', content: 'hi' }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }).kind).toBe('other')
  })

  it('reports a new tool call as a patch pending until the agent says otherwise', () => {
    expect(normalizeUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests' }))
      .toEqual({ kind: 'tool-call', patch: { toolCallId: 't1', title: 'Run tests', status: 'pending' } })
    expect(normalizeUpdate({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Read', status: 'in_progress', name: null, kind: 'read' }))
      .toEqual({ kind: 'tool-call', patch: { toolCallId: 't2', title: 'Read', name: null, kind: 'read', status: 'in_progress' } })
  })

  it('carries every optional tool-call field, including explicit clears', () => {
    const content = [{ type: 'content', content: { type: 'text', text: 'ok' } }]
    const update = normalizeUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      title: null,
      kind: null,
      name: 'bash',
      status: 'completed',
      content,
      locations: [{ path: '/a' }],
      rawInput: { command: 'ls' },
      rawOutput: 'a',
    })
    expect(update).toEqual({
      kind: 'tool-call',
      patch: { toolCallId: 't1', title: null, name: 'bash', kind: null, status: 'completed', content, locations: [{ path: '/a' }], rawInput: { command: 'ls' }, rawOutput: 'a' },
    })
    expect(normalizeUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', content: null, locations: null }))
      .toEqual({ kind: 'tool-call', patch: { toolCallId: 't1', content: null, locations: null } })
  })

  it('maps a tool call without an id or with malformed content to other', () => {
    expect(normalizeUpdate({ sessionUpdate: 'tool_call', title: 'x' }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', content: 'not a list' }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', content: ['not a block'] }).kind).toBe('other')
  })

  it('reads a plan as entries', () => {
    const entries = [{ content: 'a', priority: 'high', status: 'pending' }, { content: 'b' }]
    expect(normalizeUpdate({ sessionUpdate: 'plan', entries })).toEqual({
      kind: 'plan',
      entries: [{ content: 'a', priority: 'high', status: 'pending' }, { content: 'b' }],
    })
    expect(normalizeUpdate({ sessionUpdate: 'plan', entries: [{ priority: 'high' }] }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'plan', entries: ['a'] }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'plan' }).kind).toBe('other')
  })

  it('reads usage numbers and cost; nothing numeric is other', () => {
    expect(normalizeUpdate({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 1 } }))
      .toEqual({ kind: 'usage', usage: { used: 10, size: 100, cost: { amount: 1 } } })
    expect(normalizeUpdate({ sessionUpdate: 'usage_update', used: '10' }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'usage_update', size: 5 })).toEqual({ kind: 'usage', usage: { size: 5 } })
    expect(normalizeUpdate({ sessionUpdate: 'usage_update', used: 1 })).toEqual({ kind: 'usage', usage: { used: 1 } })
  })

  it('reads session info, treating null fields as absent', () => {
    expect(normalizeUpdate({ sessionUpdate: 'session_info_update', title: 'A title', updatedAt: '2026-01-01' }))
      .toEqual({ kind: 'session-info', title: 'A title', updatedAt: '2026-01-01' })
    expect(normalizeUpdate({ sessionUpdate: 'session_info_update', title: null })).toEqual({ kind: 'session-info' })
  })

  it('reads a notice, requiring its title', () => {
    expect(normalizeUpdate({ sessionUpdate: 'notice', title: 'Heads up', description: null, severity: 'warning' }))
      .toEqual({ kind: 'notice', title: 'Heads up', severity: 'warning' })
    expect(normalizeUpdate({ sessionUpdate: 'notice', title: 'Heads up', description: 'why' }))
      .toEqual({ kind: 'notice', title: 'Heads up', message: 'why' })
    expect(normalizeUpdate({ sessionUpdate: 'notice' }).kind).toBe('other')
  })

  it('reads a state update, naming unknown states and stop reasons as unknown', () => {
    expect(normalizeUpdate({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }))
      .toEqual({ kind: 'state', state: 'idle', stopReason: 'end_turn' })
    expect(normalizeUpdate({ sessionUpdate: 'state_update', state: 'idle', stopReason: null }))
      .toEqual({ kind: 'state', state: 'idle' })
    expect(normalizeUpdate({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'something_new' }))
      .toEqual({ kind: 'state', state: 'idle', stopReason: 'unknown' })
    expect(normalizeUpdate({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'error', error: { message: 'quota' } }))
      .toEqual({ kind: 'state', state: 'idle', stopReason: 'error', error: 'quota' })
    expect(normalizeUpdate({ sessionUpdate: 'state_update', state: 'idle', error: { code: 1 } }))
      .toEqual({ kind: 'state', state: 'idle' })
    for (const [state, expected] of [['running', 'running'], ['requires_action', 'requires_action'], ['unknown', 'unknown'], ['paused', 'unknown']] as const) {
      expect(normalizeUpdate({ sessionUpdate: 'state_update', state })).toEqual({ kind: 'state', state: expected })
    }
  })

  it('passes every other variant through as other', () => {
    const raw = { sessionUpdate: 'future_thing', nested: { a: 1 } }
    expect(normalizeUpdate(raw)).toEqual({ kind: 'other', sessionUpdate: 'future_thing', update: raw })
  })
})

describe('plan, option, and command reports', () => {
  it('reads a named plan whole, and the legacy one without an id', () => {
    const entry = { content: 'Ship it', priority: 'high', status: 'in_progress' }
    expect(normalizeUpdate({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p1', entries: [entry] } }))
      .toEqual({ kind: 'plan', entries: [entry], planId: 'p1' })
    expect(normalizeUpdate({ sessionUpdate: 'plan', entries: [{ content: 'One' }] })).toEqual({ kind: 'plan', entries: [{ content: 'One' }] })
  })

  it('leaves a plan kept as a document, a malformed one, and an unidentified removal as other', () => {
    const markdown = { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p1', content: '# Plan' } }
    expect(normalizeUpdate(markdown)).toEqual({ kind: 'other', sessionUpdate: 'plan_update', update: markdown })
    expect(normalizeUpdate({ sessionUpdate: 'plan_update', plan: { type: 'items', entries: [] } }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p1', entries: 'x' } }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'plan', entries: 'x' }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'plan_removed' }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'plan_removed', planId: 'p1' })).toEqual({ kind: 'plan-removed', planId: 'p1' })
  })

  it('reads the mode, every option, and every command an agent reports', () => {
    expect(normalizeUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })).toEqual({ kind: 'mode', currentModeId: 'plan' })
    const option = { id: 'model', name: 'Model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }] }
    expect(normalizeUpdate({ sessionUpdate: 'config_option_update', configOptions: [option, 'x'] }))
      .toEqual({ kind: 'config', configOptions: [option] })
    const command = { name: '/compact', description: 'Summarize', input: { hint: 'none' } }
    expect(normalizeUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [command] }))
      .toEqual({ kind: 'commands', commands: [{ name: '/compact', description: 'Summarize', inputHint: 'none' }] })
  })

  it('leaves a malformed report as other', () => {
    expect(normalizeUpdate({ sessionUpdate: 'current_mode_update' }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'config_option_update', configOptions: {} }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: '/x' }] }).kind).toBe('other')
    expect(normalizeUpdate({ sessionUpdate: 'available_commands_update', availableCommands: '/x' }).kind).toBe('other')
  })
})

describe('parseSessionUpdate', () => {
  it('reads the session id and the normalized update', () => {
    expect(parseSessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } }))
      .toEqual({ sessionId: 's1', update: { kind: 'message-chunk', content: { type: 'text', text: 'a' } } })
  })

  it('drops a malformed envelope', () => {
    expect(parseSessionUpdate(undefined)).toBeUndefined()
    expect(parseSessionUpdate('x')).toBeUndefined()
    expect(parseSessionUpdate({ sessionId: 1, update: { sessionUpdate: 'plan' } })).toBeUndefined()
    expect(parseSessionUpdate({ sessionId: 's1', update: 'plan' })).toBeUndefined()
    expect(parseSessionUpdate({ sessionId: 's1', update: { entries: [] } })).toBeUndefined()
  })
})

describe('value readers', () => {
  it('recognizes JSON objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('map stop reasons and work states onto the closed vocabularies', () => {
    for (const reason of ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error']) {
      expect(toStopReason(reason)).toBe(reason)
    }
    expect(toStopReason('other')).toBe('unknown')
    expect(toStopReason(undefined)).toBe('unknown')
    expect(toWorkState('running')).toBe('running')
    expect(toWorkState('idle')).toBe('idle')
    expect(toWorkState('requires_action')).toBe('requires_action')
    expect(toWorkState('x')).toBe('unknown')
  })
})
