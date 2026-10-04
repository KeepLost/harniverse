// @vitest-environment jsdom
/** Call-scoped preparation subscriptions and file-mutation progress. */
import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AssistantBlock, ConversationSnapshot, RunningToolCall, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'

import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { conversationSnapshot, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh as conversationZh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { en, zh } from '../src/client/locales.ts'
import { useToolCallArgumentsPartial } from '../src/client/tool/tool-call-arguments-partial.ts'
import { FileMutationRow } from '../src/client/tool/toolviews/file-mutation-row.tsx'

afterEach(cleanup)

const t = makeTranslate(conversationZh, commonZh)

/** The session's live partial assistant projection blocks. */
function blocks(first: string, second = ''): readonly AssistantBlock[] {
  return [
    { kind: 'text', text: 'Preparing changes' },
    { kind: 'tool-call', callId: 'first', name: 'write', argsRaw: first },
    { kind: 'tool-call', callId: 'second', name: 'edit', argsRaw: second },
  ]
}

/**
 * A useSession standard seat over a replaceable snapshot (the framework's own
 * subscription machinery is not under test here).
 */
function sessionSeat(initial: readonly AssistantBlock[]) {
  const store = createSnapshotStore<ConversationSnapshot>(
    { ...conversationSnapshot('session' as ConversationSnapshot['sessionId']), partial: { turn: 1, step: 1, blocks: initial } },
  )
  const read = <T,>(selector: (snapshot: ConversationSnapshot) => T): T => selector(store.getSnapshot())
  return {
    set: (next: readonly AssistantBlock[]) => {
      store.set({ ...conversationSnapshot('session' as ConversationSnapshot['sessionId']), partial: { turn: 1, step: 1, blocks: next } })
    },
    useSession: read as Parameters<typeof FileMutationRow>[0]['useSession'],
  }
}

describe('tool argument prefix Hook', () => {
  it('reads only this call prefix from the session partial', () => {
    const seat = sessionSeat(blocks('{', 'second prefix'))
    const read = (callId: string): string => useToolCallArgumentsPartial(seat.useSession, callId)
    expect(read('first')).toBe('{')
    expect(read('second')).toBe('second prefix')
    expect(read('missing')).toBe('')
    act(() => { seat.set(blocks('{"file_path":', 'second prefix')) })
    expect(read('first')).toBe('{"file_path":')
    expect(read('second')).toBe('second prefix')
    act(() => { seat.set([]) })
    expect(read('first')).toBe('')
  })

  it.each([
    ['write', en, 'Preparing content'],
    ['edit', zh, '正在准备内容'],
  ] as const)('%s rounds the raw prefix length upward to whole kilobytes', (toolName, dictionary, label) => {
    const seat = sessionSeat(blocks(''))
    const tTool = makeTranslate(dictionary)
    const block: RunningToolCall = {
      phase: 'preparing', callId: 'first', name: toolName, turn: 1, step: 1, time: 1,
      argsRaw: '', callView: null, subCalls: [],
    }
    const row = (next: RunningToolCall | ToolResultNode) => {
      const props = {
        callId: 'first',
        toolName,
        block: next,
        useSession: seat.useSession,
        t,
        tTool,
        openFile: vi.fn(),
      } as unknown as Parameters<typeof FileMutationRow>[0]
      return <FileMutationRow {...props} />
    }
    const view = render(row(block))
    for (const [length, kilobytes] of [[0, 0], [1, 1], [1024, 1], [1025, 2], [12 * 1024, 12]]) {
      act(() => { seat.set(blocks('中'.repeat(length!))) })
      view.rerender(row(block))
      expect(view.getByText(`${label} ${kilobytes}KB`)).toBeTruthy()
      expect(view.queryByRole('button')).toBeNull()
    }
    const started: RunningToolCall = {
      phase: 'start', callId: 'first', name: toolName, turn: 1, step: 1, time: 2,
      argsRaw: '{"file_path":"file.txt","content":"hello"}', callView: null, subCalls: [],
    }
    view.rerender(row(started))
    expect(view.getByText('file.txt')).toBeTruthy()
    const result: ToolResultNode = {
      kind: 'tool-result', callId: 'first', seq: 3, time: 3, callTime: 2,
      call: { name: toolName, argsRaw: started.argsRaw },
      content: [], isError: false, callView: null, resultView: null, subCalls: [],
    }
    view.rerender(row(result))
    expect(view.getByText('file.txt')).toBeTruthy()
  })
})
