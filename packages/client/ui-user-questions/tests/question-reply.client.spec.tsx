// @vitest-environment jsdom
/** Answered-batch conversation node: fold determinism and the reply bubble renderer. */
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChatSnapshot, ConversationEventInput, ConversationNodeDefinition,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { QuestionReplyBubble, QuestionReplyView } from '../src/client/QuestionReplyView.tsx'
import {
  answeredQuestionDefinition, replyAnswerValues, replyClipboardText, type QuestionReplyData,
} from '../src/client/question-reply.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const CALL_ARGUMENTS = JSON.stringify({ questions: [
  { id: 'scope', question: '选择哪个范围？', header: '范围', options: [{ label: '仅工具' }] },
  { id: 'notes', question: '还有其他要求吗？' },
] })
const RESULT_TEXT = JSON.stringify({ answers: [
  { id: 'notes', selected: [] },
  { id: 'scope', selected: ['仅工具'], custom: '备注' },
] })

function toolCall(argumentsText = CALL_ARGUMENTS, name = 'ask_user_question'): ConversationEventInput {
  return {
    event: {
      seq: 5, time: 5_000, type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name, arguments: argumentsText },
    } as ConversationEventInput['event'],
    view: undefined,
  }
}

function toolResult(text = RESULT_TEXT, isError = false, surfaceOp = 'append'): ConversationEventInput {
  return {
    event: {
      seq: 6, time: 6_000, type: 'tool/result', surfaceOp,
      data: {
        turn: 1, step: 1,
        message: {
          id: 'msg-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError, content: [{ type: 'text', text }] }],
        },
      },
    } as ConversationEventInput['event'],
    view: undefined,
  }
}

/** A tool/result whose inner blocks are not exactly one text block. */
function toolResultBlocks(content: unknown[]): ConversationEventInput {
  return {
    event: {
      seq: 6, time: 6_000, type: 'tool/result', surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'msg-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', content }],
        },
      },
    } as ConversationEventInput['event'],
    view: undefined,
  }
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return [answeredQuestionDefinition]
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function assembler() {
  const run = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  return {
    run,
    nodes: () => {
      const value = run.snapshot('chat') as ChatSnapshot | undefined
      return [...(value?.nodes.values() ?? [])]
    },
  }
}

describe('answeredQuestionDefinition', () => {
  it('folds one answered batch identically from replay, live append, and history prepend', () => {
    const expected = {
      kind: 'question-reply',
      anchorSeq: 6,
      visibility: 'visible',
      data: {
        callId: 'call-1',
        outcome: 'answered',
        questions: [
          { id: 'scope', question: '选择哪个范围？', header: '范围' },
          { id: 'notes', question: '还有其他要求吗？' },
        ],
        answers: [
          { id: 'notes', selected: [] },
          { id: 'scope', selected: ['仅工具'], custom: '备注' },
        ],
        text: RESULT_TEXT,
        time: 6_000,
      },
    }
    const replay = assembler()
    replay.run.replaceWindow([toolCall(), toolResult()], false)
    replay.run.flush()
    expect(replay.nodes()).toHaveLength(1)
    expect(replay.nodes()[0]).toMatchObject(expected)
    expect(replay.nodes()[0]?.data).not.toHaveProperty('seq')

    const live = assembler()
    live.run.replaceWindow([], false)
    live.run.append(toolCall())
    live.run.flush()
    expect(live.nodes()).toEqual([])
    live.run.append(toolResult())
    live.run.flush()
    expect(live.nodes().map(({ location: _location, ...node }) => node))
      .toEqual(replay.nodes().map(({ location: _location, ...node }) => node))

    const prepend = assembler()
    prepend.run.replaceWindow([toolResult()], true)
    prepend.run.flush()
    expect(prepend.nodes()).toEqual([])
    prepend.run.prepend([toolCall()], false)
    prepend.run.flush()
    expect(prepend.nodes().map(({ location: _location, ...node }) => node))
      .toEqual(replay.nodes().map(({ location: _location, ...node }) => node))
  })

  it.each([
    'null', 'not json', '{"answers":"wrong"}', '{"answers":[]}',
    '{"answers":[{"id":"scope","selected":[]},{"id":"scope","selected":[]}]}',
    '{"answers":[{"id":"scope","selected":[1]},{"id":"notes","selected":[]}]}',
    '{"answers":[{"id":"scope","selected":[],"custom":1},{"id":"notes","selected":[]}]}',
    '{"answers":[{"id":"wrong","selected":[]},{"id":"notes","selected":[]}]}',
  ])('keeps the generic Tool presentation for an unreadable result %s', (text) => {
    const run = assembler()
    run.run.replaceWindow([toolCall(), toolResult(text)], false)
    run.run.flush()
    expect(run.nodes()).toEqual([])
  })

  it.each(['not json', '{"questions":[]}', '{"questions":[{"id":1}]}',
    '{"questions":[{"id":"scope","question":"A"},{"id":"scope","question":"B"}]}',
  ])('pairs no batch from unsafe call arguments %s', (args) => {
    const run = assembler()
    run.run.replaceWindow([toolCall(args), toolResult()], false)
    run.run.flush()
    expect(run.nodes()).toEqual([])
  })

  it('keeps failed asks, non-text content, non-appended results, and other tools out', () => {
    expect(answeredQuestionDefinition.match(toolCall(CALL_ARGUMENTS, 'bash').event)).toBeNull()
    expect(answeredQuestionDefinition.match(toolResult(RESULT_TEXT, false, 'replace').event)).toBeNull()
    for (const result of [toolResult(RESULT_TEXT, true), toolResult('{"answers":[]}'), toolResultBlocks([])]) {
      const run = assembler()
      run.run.replaceWindow([toolCall(), result], false)
      run.run.flush()
      expect(run.nodes()).toEqual([])
    }
  })

  it('covers the required Definition interface paths directly', () => {
    const state = answeredQuestionDefinition.start({} as never, {
      event: toolCall().event, id: 'call-1', role: 'start',
    } as never, {} as never)
    expect(state.questions).not.toBeNull()
    // An update that is not a tool result leaves the pending state untouched.
    expect(answeredQuestionDefinition.update({ state } as never, {
      event: toolCall().event, id: 'call-1', role: 'update',
    } as never)).toBe(state)
    expect(answeredQuestionDefinition.buildViewNode!({
      state: undefined, current: new Map(), key: 'k', id: 'call-1',
    } as never)).toBeNull()
    // Pending: an already published node hides instead of withdrawing.
    const pending = answeredQuestionDefinition.buildViewNode!({
      state, current: new Map(), key: 'k', id: 'call-1',
    } as never)
    expect(pending).toBeNull()
    const visible = answeredQuestionDefinition.buildViewNode!({
      state, current: new Map([['chat', { key: 'k', visibility: 'visible' }]]), key: 'k', id: 'call-1',
    } as never)
    expect(visible).toMatchObject({ key: 'k', visibility: 'hidden' })

    const answered = answeredQuestionDefinition.update({ state } as never, {
      event: toolResult().event, id: 'call-1', role: 'update',
    } as never)
    const node = answeredQuestionDefinition.buildViewNode!({
      state: answered, current: new Map(), key: 'k', id: 'call-1', start: undefined,
    } as never)
    expect(node).toMatchObject({ kind: 'question-reply', visibility: 'visible', location: { kind: 'unresolved' } })
    expect(() => answeredQuestionDefinition.start({} as never, {
      event: toolResult().event, id: 'call-1', role: 'start',
    } as never, {} as never)).toThrow(/requires tool\/call/)
  })
})

const t = makeTranslate(zh, commonZh)
const replyData = (overrides: Partial<QuestionReplyData> = {}): QuestionReplyData => ({
  callId: 'call-1',
  outcome: 'answered',
  questions: [
    { id: 'scope', question: '选择哪个范围？', header: '范围' },
    { id: 'notes', question: '还有其他要求吗？' },
  ],
  answers: [{ id: 'scope', selected: ['仅工具'], custom: '备注' }, { id: 'notes', selected: [] }],
  text: RESULT_TEXT,
  time: 7_000,
  ...overrides,
})

describe('replyAnswerValues and replyClipboardText', () => {
  it('orders selected labels before a non-blank custom answer', () => {
    expect(replyAnswerValues(replyData(), 'scope')).toEqual(['仅工具', '备注'])
    expect(replyAnswerValues(replyData(), 'notes')).toEqual([])
    expect(replyAnswerValues(replyData(), 'absent')).toEqual([])
    expect(replyAnswerValues(replyData({ answers: [{ id: 'scope', selected: [], custom: '  ' }] }), 'scope'))
      .toEqual([])
  })

  it('pairs every question with its answer and names skipped questions', () => {
    expect(replyClipboardText(replyData(), t)).toBe('范围 — 选择哪个范围？\n回答：仅工具, 备注\n\n还有其他要求吗？\n已跳过')
    expect(replyClipboardText(replyData({
      questions: [{ id: 'scope', question: '选择哪个范围？', header: '选择哪个范围？' }],
      answers: [{ id: 'scope', selected: ['仅工具'] }],
    }), t)).toBe('选择哪个范围？\n回答：仅工具')
    expect(replyClipboardText(replyData({ questions: [], text: 'raw' }), t)).toBe('raw')
  })
})

/** Render the keyed Chat renderer itself; the framework props it never reads are stubbed. */
function renderView(data: QuestionReplyData) {
  const props: Partial<ComponentProps<typeof QuestionReplyView>> = {
    node: {
      key: 'answered:1', id: 'call-1', kind: 'question-reply', target: 'chat', anchorSeq: 6,
      location: { kind: 'session' }, visibility: 'visible', data,
    },
    openFile: vi.fn(),
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    fileMentions: vi.fn(),
    t,
  }
  return render(<QuestionReplyView {...props as ComponentProps<typeof QuestionReplyView>} />)
}

describe('QuestionReplyView', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  afterEach(() => {
    if (originalClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', originalClipboard)
  })

  it('renders collapsed with the chosen answers and expands in place', () => {
    render(<QuestionReplyBubble data={replyData()} t={t} />)
    const group = screen.getByRole('group', { name: '问题与回答' })
    expect(group.getAttribute('data-question-reply')).toBe('call-1')
    // Collapsed face: the compact answer summary, not the question list.
    expect(within(group).getByText('仅工具, 备注')).toBeTruthy()
    expect(within(group).queryByText('选择哪个范围？')).toBeNull()

    const toggle = within(group).getByRole('button', { name: '问题与回答 · 展开' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('问题与回答 · 收起')
    expect(within(group).getByText('范围')).toBeTruthy()
    expect(within(group).getAllByText('选择哪个范围？')).toHaveLength(1)
    // The skipped question says so in place of its empty answer.
    const pairs = within(group).getAllByRole('definition')
    expect(pairs[1]?.textContent).toBe('已跳过')
    fireEvent.click(toggle)
    expect(within(group).queryByText('选择哪个范围？')).toBeNull()
  })

  it('falls back to the model-facing text when the payload carried no questions', () => {
    render(<QuestionReplyBubble data={replyData({ questions: [], answers: [], text: '原始回复' })} t={t} />)
    const group = screen.getByRole('group', { name: '问题与回答' })
    // No question paired an answer: the summary names the skipped batch.
    expect(within(group).getByText('已跳过')).toBeTruthy()
    fireEvent.click(within(group).getByRole('button', { name: '问题与回答 · 展开' }))
    expect(within(group).getByText('原始回复')).toBeTruthy()
  })

  it('drops a header that repeats its question', () => {
    render(<QuestionReplyBubble data={replyData({
      questions: [{ id: 'scope', question: '选择哪个范围？', header: '选择哪个范围？' }],
      answers: [{ id: 'scope', selected: ['仅工具'] }],
    })} t={t} />)
    const group = screen.getByRole('group', { name: '问题与回答' })
    fireEvent.click(within(group).getByRole('button', { name: '问题与回答 · 展开' }))
    expect(within(group).getAllByText('选择哪个范围？')).toHaveLength(1)
  })

  it('copies each question with its answer, then confirms the write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<QuestionReplyBubble data={replyData()} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('范围 — 选择哪个范围？\n回答：仅工具, 备注\n\n还有其他要求吗？\n已跳过')
    // Two microtask ticks: writeClipboard's own await, then the .then that
    // lands the success chrome.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: '复制成功' }))
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the clipboard refuses and confirms for one second', async () => {
    vi.useFakeTimers()
    try {
      const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      render(<QuestionReplyBubble data={replyData()} t={t} />)

      fireEvent.click(screen.getByRole('button', { name: '复制' }))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.queryByRole('button', { name: '复制成功' })).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: '复制' }))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders through the conversation.chat.node slot with the same bubble', () => {
    renderView(replyData())
    const group = screen.getByRole('group', { name: '问题与回答' })
    expect(within(group).getByText(/\d{2}:\d{2}/)).toBeTruthy()
    expect(within(group).getByRole('button', { name: '复制' })).toBeTruthy()
  })
})
