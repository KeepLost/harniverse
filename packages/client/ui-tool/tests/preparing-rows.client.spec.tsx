// @vitest-environment jsdom
/** Preparation rows: tool-owned prefix without arguments or disclosure. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ConversationSnapshot, RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { conversationSnapshot, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh as conversationZh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { zh } from '../src/client/locales.ts'
import { GenericToolCard } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { FileMutationRow } from '../src/client/tool/toolviews/file-mutation-row.tsx'
import { ReadRow } from '../src/client/tool/toolviews/read-row.tsx'
import { BashRow } from '../src/client/tool/toolviews/bash-sample.tsx'
import { isPreparingCall, toolRowModel } from '../src/client/tool/models/tool-call-model.ts'

afterEach(cleanup)

const t = makeTranslate(conversationZh, commonZh)
const tTool = makeTranslate(zh)

/** A useSession standard seat over the quiescent snapshot (no live prefix here). */
const useSession = ((selector: (snapshot: ReturnType<typeof conversationSnapshot>) => unknown) =>
  selector(conversationSnapshot('session' as ConversationSnapshot['sessionId']))) as Parameters<
  typeof ReadRow
>[0]['useSession']

type PreparationProps = Parameters<typeof ReadRow>[0] & Pick<Parameters<typeof BashRow>[0], 'useSessions'>

function preparation(name: string): PreparationProps {
  return {
    callId: 'call',
    toolName: name,
    block: {
      phase: 'preparing', callId: 'call', name, turn: 1, step: 1, time: 1,
      argsRaw: '', callView: null, subCalls: [],
    } satisfies RunningToolCall,
    useSession,
    t, tTool, openFile: vi.fn(),
  } as unknown as PreparationProps
}

describe('argument-free tool preparation', () => {
  it.each([
    ['read', ReadRow], ['write', FileMutationRow], ['edit', FileMutationRow],
    ['bash', BashRow], ['run_code', GenericToolCard], ['custom_tool', GenericToolCard],
  ] as const)('%s has a tool-owned prefix without arguments or disclosure', (name, Component) => {
    const props = preparation(name)
    const view = render(<Component {...props} />)
    expect(view.container.querySelector('[data-state="preparing"]')).not.toBeNull()
    expect(view.container.querySelector('svg')).not.toBeNull()
    expect(view.container.textContent?.trim()).not.toBe('')
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('pre')).toBeNull()
    expect(isPreparingCall(props.block)).toBe(true)
    expect(toolRowModel(name, props.block)).toMatchObject({
      state: 'preparing', body: null, output: null, filePath: undefined,
    })
    fireEvent.click(view.container.firstElementChild!)
    fireEvent.keyDown(view.container.firstElementChild!, { key: 'Enter' })
    expect(view.container.querySelector('[aria-expanded="true"]')).toBeNull()
  })

  it('replaces preparation with the dispatched row and retains that row through the result', () => {
    const props = preparation('write')
    const view = render(<FileMutationRow {...props} />)
    const preparingRow = view.container.querySelector('[data-tool="write"]')
    const started: RunningToolCall = {
      phase: 'start', callId: 'call', name: 'write', turn: 1, step: 1, time: 2,
      argsRaw: '{"file_path":"hello.txt","content":"hello"}', callView: null, subCalls: [],
    }
    view.rerender(<FileMutationRow {...props} block={started} />)
    const row = view.container.querySelector('[data-tool="write"]')
    expect(row).not.toBe(preparingRow)
    expect(view.getByText('hello.txt')).toBeTruthy()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
    const result: ToolResultNode = {
      kind: 'tool-result', seq: 3, time: 3, callId: 'call', callTime: 2,
      call: { name: 'write', argsRaw: started.argsRaw },
      content: [], isError: false, callView: null, resultView: null, subCalls: [],
    }
    view.rerender(<FileMutationRow {...props} block={result} />)
    expect(view.container.querySelector('[data-tool="write"]')).toBe(row)
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
  })

  it('retains the generic title and tool-name rule while arguments are absent', () => {
    const props = preparation('custom_tool')
    const view = render(<GenericToolCard {...props} />)
    expect(view.getByText('Tool call', { exact: true })).toBeTruthy()
    expect(toolRowModel('custom_tool', props.block).summary).toBe('custom_tool')
    expect(view.getByText('custom_tool', { exact: true })).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
    const started: RunningToolCall = {
      phase: 'start', callId: 'call', name: 'custom_tool', turn: 1, step: 1, time: 2,
      argsRaw: '{"prompt":"Inspect this file"}', callView: null, subCalls: [],
    }
    view.rerender(<GenericToolCard {...props} block={started} />)
    expect(view.getByText('Tool call', { exact: true })).toBeTruthy()
    expect(view.getByText('custom_tool · Inspect this file', { exact: true })).toBeTruthy()
    expect(view.getByRole('button', { expanded: false })).toBeTruthy()
  })

  it('keeps specialized Bash session hooks outside its preparation branch', () => {
    const useSessions = vi.fn(() => {
      throw new Error('Bash call details are unavailable during preparation')
    })
    const view = render(<BashRow {...preparation('bash')} useSessions={useSessions} />)
    expect(view.container.querySelector('[data-state="preparing"]')).not.toBeNull()
    expect(useSessions).not.toHaveBeenCalled()
    expect(view.queryByRole('button')).toBeNull()
  })
})
