import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import type { RunningToolCall, ToolCallBlock } from '../src/client/contract/conversation-snapshot.ts'
import {
  MAX_TOOL_CALL_TREE_DEPTH, ToolCallTree,
} from '../src/client/sessions/tool-call-tree.ts'

const at = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, type, data }) as unknown as SessionEvent

const start = (seq: number, parentCallId: string, subCallId: string): SessionEvent =>
  at(seq, 'tool/code-dispatch-start', {
    parentCallId, subCallId, name: 'run_code', arguments: {},
  })

const settle = (seq: number, parentCallId: string, subCallId: string): SessionEvent =>
  at(seq, 'tool/code-dispatch', {
    parentCallId, subCallId, name: 'run_code', arguments: {},
    isError: false, content: [],
  })

const root = (callId: string): RunningToolCall => ({
  callId, name: 'run_code', argsRaw: '{}', turn: 1, step: 1,
  time: 1_700_000_000_000, callView: null, subCalls: [],
})

/** A fan-out wide enough that a per-event sibling scan or copy costs seconds; the linear fold takes a fraction of a second. */
const WIDE_FAN_OUT = 20_000
/** Wall-clock ceiling for applying and projecting the wide fan-out. */
const WIDE_FAN_OUT_BUDGET_MS = 5_000

describe('ToolCallTree', () => {
  it('rejects a self-parenting dispatch edge', () => {
    const tree = new ToolCallTree()
    const roots = [root('root')]

    expect(tree.apply(start(0, 'root', 'root'))).toBe(true)
    expect(tree.projectRunningCalls(roots)).toBe(roots)
  })

  it('rejects a settling edge that would close a multi-call cycle', () => {
    const tree = new ToolCallTree()
    tree.apply(start(0, 'a', 'b'))
    tree.apply(start(1, 'b', 'c'))

    expect(tree.apply(settle(2, 'c', 'a'))).toBe(true)
    expect(tree.projectRunningCalls([root('a')])).toMatchObject([{
      callId: 'a',
      subCalls: [{
        callId: 'b',
        subCalls: [{ callId: 'c', subCalls: [] }],
      }],
    }])
  })

  it('accepts an acyclic graph with a shared descendant', () => {
    const tree = new ToolCallTree()
    tree.apply(start(0, 'a', 'b'))
    tree.apply(start(1, 'a', 'c'))
    tree.apply(start(2, 'b', 'd'))
    tree.apply(start(3, 'c', 'd'))

    expect(tree.apply(start(4, 'root', 'a'))).toBe(true)
    expect(tree.projectRunningCalls([root('root')])).toMatchObject([{
      callId: 'root',
      subCalls: [{
        callId: 'a',
        subCalls: [{ callId: 'b' }, { callId: 'c' }],
      }],
    }])
  })

  it('rejects an edge beyond the recursive depth safety limit', () => {
    const tree = new ToolCallTree()
    for (let depth = 1; depth < MAX_TOOL_CALL_TREE_DEPTH; depth++) {
      tree.apply(start(depth, `call-${depth - 1}`, `call-${depth}`))
    }

    expect(tree.apply(start(
      MAX_TOOL_CALL_TREE_DEPTH,
      `call-${MAX_TOOL_CALL_TREE_DEPTH - 1}`,
      `call-${MAX_TOOL_CALL_TREE_DEPTH}`,
    ))).toBe(true)

    let current: ToolCallBlock = tree.projectRunningCalls([root('call-0')])[0]!
    let depth = 1
    while (current.subCalls.length > 0) {
      current = current.subCalls[0]!
      depth++
    }
    expect(depth).toBe(MAX_TOOL_CALL_TREE_DEPTH)
    expect(current.callId).toBe(`call-${MAX_TOOL_CALL_TREE_DEPTH - 1}`)
  })

  it('keeps first-attachment order, ignores a repeated start, and leaves an earlier projection unchanged', () => {
    const tree = new ToolCallTree()
    const roots = [root('root')]
    tree.apply(start(0, 'root', 'b'))
    tree.apply(start(1, 'root', 'a'))
    tree.apply(start(2, 'root', 'b'))
    tree.apply(settle(3, 'root', 'a'))
    tree.apply(start(4, 'root', 'c'))

    const published = tree.projectRunningCalls(roots)
    expect(published).toMatchObject([{
      callId: 'root',
      subCalls: [
        { callId: 'b', phase: 'start' },
        { callId: 'a', kind: 'tool-result', callTime: 1_700_000_000_001 },
        { callId: 'c', phase: 'start' },
      ],
    }])

    tree.apply(settle(5, 'root', 'b'))
    const next = tree.projectRunningCalls(roots)
    expect(next).not.toBe(published)
    expect(next[0]?.subCalls.map(subCall => subCall.callId)).toEqual(['b', 'a', 'c'])
    expect(next[0]?.subCalls[0]).toMatchObject({ kind: 'tool-result', callTime: 1_700_000_000_000 })
    expect(next[0]?.subCalls[1]).toBe(published[0]?.subCalls[1])
    expect(next[0]?.subCalls[2]).toBe(published[0]?.subCalls[2])
    expect(published[0]?.subCalls[0]).toMatchObject({ callId: 'b', phase: 'start' })
    expect(tree.projectRunningCalls(roots)).toBe(next)
  })

  it('applies and projects a wide Code Dispatch fan-out inside its budget', () => {
    const tree = new ToolCallTree()
    const started = performance.now()
    for (let index = 0; index < WIDE_FAN_OUT; index++) {
      tree.apply(start(index * 2, 'root', `call-${index}`))
      tree.apply(settle(index * 2 + 1, 'root', `call-${index}`))
    }
    const projected = tree.projectRunningCalls([root('root')])
    const elapsedMs = performance.now() - started

    const subCalls = projected[0]?.subCalls ?? []
    expect(subCalls).toHaveLength(WIDE_FAN_OUT)
    expect(subCalls.slice(0, 3).map(subCall => subCall.callId)).toEqual(['call-0', 'call-1', 'call-2'])
    expect(subCalls.at(-1)?.callId).toBe(`call-${WIDE_FAN_OUT - 1}`)
    expect(elapsedMs, `applied ${WIDE_FAN_OUT} dispatches in ${Math.round(elapsedMs)} ms`).toBeLessThan(WIDE_FAN_OUT_BUDGET_MS)
  }, 60_000)
})
