// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  ConversationSnapshot, SessionId, SessionSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { ArchivePanel } from '../src/client/ArchivePanel.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: WorkspaceBrowserProps['t'] = makeTranslate(zh, commonZh)
const sid = (id: string) => id as SessionId

type OpenArchive = WorkspaceBrowserProps['openArchive']
type DeleteSession = WorkspaceBrowserProps['deleteSession']
type LoadOlder = WorkspaceBrowserProps['loadArchiveOlder']

const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 1, ...overrides,
})

const snapshotOf = (id: string, nodes: readonly unknown[], hasMore = false) => ({
  sessionId: sid(id), nodes, hasMore,
}) as ConversationSnapshot

const okOpen = (id: string, nodes: readonly unknown[], hasMore = false) => ({
  ok: true as const,
  value: { snapshot: snapshotOf(id, nodes, hasMore) },
})

const failed = (message: string) => ({
  ok: false as const, error: { code: 'internal' as const, message, details: {} },
})

const okDelete = { ok: true as const, value: { deleted: true as const, attachmentsRetained: true as const } }

const userNode = (seq: number, content: readonly unknown[], kind: 'user' | 'steering' = 'user'): unknown => (
  kind === 'user'
    ? { kind, seq, time: 1, content, source: { kind: 'user' } }
    : { kind, seq, time: 1, messageId: `m${seq}`, content, source: { kind: 'user' } }
)
const assistantNode = (seq: number, blocks: readonly unknown[]): unknown => ({ kind: 'assistant', seq, time: 1, turn: 1, step: 0, blocks })
const toolResultNode = (seq: number, content: unknown): unknown => (
  { kind: 'tool-result', seq, time: 1, callId: `c${seq}`, call: { name: 'tool' }, callTime: 1, content, isError: false }
)
const contextNode = (seq: number): unknown => ({ kind: 'context', seq, time: 1, content: [], source: { kind: 'user' }, provenance: [], form: 'manual' })

interface MountOptions {
  items?: readonly SessionSummary[]
  currentId?: SessionId
  openArchive?: OpenArchive
  loadArchiveOlder?: LoadOlder
  unarchiveSession?: WorkspaceBrowserProps['unarchiveSession']
  deleteSession?: DeleteSession
}

function mount(options: MountOptions = {}) {
  const props = {
    items: options.items ?? [],
    currentId: options.currentId,
    openArchive: options.openArchive ?? (vi.fn(async () => okOpen('a', []))),
    loadArchiveOlder: options.loadArchiveOlder ?? (vi.fn(async () => failed('not configured'))),
    unarchiveSession: options.unarchiveSession ?? (vi.fn(async () => {})),
    deleteSession: options.deleteSession ?? (vi.fn(async () => okDelete)),
    t,
  }
  const view = render(<ArchivePanel {...props} />)
  return {
    view,
    props,
    rerender(next: MountOptions = {}) {
      Object.assign(props, {
        items: next.items ?? props.items,
        currentId: 'currentId' in next ? next.currentId : props.currentId,
      })
      view.rerender(<ArchivePanel {...props} />)
    },
  }
}

const previewDialog = (): HTMLElement => screen.getAllByRole('dialog')[0]!
const confirmDialog = (): HTMLElement => screen.getAllByRole('dialog')[1]!

/** Exact-text lookup across rendered blocks; RTL's normalizer would collapse the joined newlines. */
const exactText = (expected: string): Element => {
  const found = [...document.querySelectorAll('div,pre,article')].find(node => node.textContent === expected)
  expect(found, `expected exact text ${JSON.stringify(expected)}`).toBeDefined()
  return found!
}

describe('ArchivePanel list', () => {
  it('shows the empty state and keeps the batch button inert without selection', () => {
    mount()
    expect(screen.getByText('暂无归档会话')).toBeTruthy()
    const removeSelected = screen.getByRole('button', { name: '删除所选' }) as HTMLButtonElement
    expect(removeSelected.disabled).toBe(true)
    const selectAll = screen.getByLabelText('全选归档会话') as HTMLInputElement
    expect(selectAll.checked).toBe(false)
    expect(screen.getByText('已选择 0 个')).toBeTruthy()
  })

  it('renders rows with the workspace cwd or id fallback and marks the current session', () => {
    mount({
      items: [summary('甲', { cwd: '/work/root' }), summary('乙', { displayTitle: '会话乙' })],
      currentId: sid('乙'),
    })
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('/work/root')).toBeTruthy()
    expect(within(rows[1]!).getByText('乙')).toBeTruthy()
    expect(rows[1]!.className).toContain('current')
    expect(rows[0]!.className).not.toContain('current')
  })

  it('toggles one row, all rows, and back through the select-all checkbox', () => {
    mount({ items: [summary('甲'), summary('乙')] })
    const rowBox = screen.getByLabelText('选择归档会话“甲”')
    fireEvent.click(rowBox)
    expect(screen.getByText('已选择 1 个')).toBeTruthy()
    const removeSelected = screen.getByRole('button', { name: '删除所选' }) as HTMLButtonElement
    expect(removeSelected.disabled).toBe(false)
    fireEvent.click(rowBox)
    expect(screen.getByText('已选择 0 个')).toBeTruthy()

    const allBox = screen.getByLabelText('全选归档会话')
    fireEvent.click(allBox)
    const selectFirst = screen.getByLabelText('选择归档会话“甲”') as HTMLInputElement
    expect(selectFirst.checked).toBe(true)
    const selectSecond = screen.getByLabelText('选择归档会话“乙”') as HTMLInputElement
    expect(selectSecond.checked).toBe(true)
    expect(screen.getByText('已选择 2 个')).toBeTruthy()
    fireEvent.click(allBox)
    expect(screen.getByText('已选择 0 个')).toBeTruthy()
    expect(removeSelected.disabled).toBe(true)
  })

  it('prunes selection and the open preview when their sessions leave the list', async () => {
    const opened = mount({ items: [summary('甲'), summary('乙')], openArchive: vi.fn(async () => okOpen('乙', [userNode(1, [{ type: 'text', text: '旧话' }])])) })
    fireEvent.click(screen.getByLabelText('选择归档会话“乙”'))
    fireEvent.click(screen.getByRole('button', { name: /乙/ }))
    await waitFor(() => { expect(screen.getByText('旧话')).toBeTruthy() })
    expect(screen.getByText('已选择 1 个')).toBeTruthy()

    opened.rerender({ items: [summary('甲')] })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.getByText('已选择 0 个')).toBeTruthy()
  })
})

describe('ArchivePanel preview', () => {
  it('surfaces the loading state, renders messages, and closes on Escape', async () => {
    let resolveOpen!: (value: ReturnType<typeof okOpen>) => void
    const openArchive = vi.fn(() => new Promise<ReturnType<typeof okOpen>>((resolve) => { resolveOpen = resolve }))
    mount({ items: [summary('甲')], openArchive })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    expect(screen.getByText('正在读取会话消息…')).toBeTruthy()
    expect(openArchive).toHaveBeenCalledWith(sid('甲'))

    await act(async () => { resolveOpen(okOpen('甲', [userNode(1, [{ type: 'text', text: '第一句' }])])) })
    expect(screen.getByText('第一句')).toBeTruthy()
    expect(screen.queryByText('正在读取会话消息…')).toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a failed open result, then rejection messages for Error and non-Error causes', async () => {
    mount({ items: [summary('甲')], openArchive: vi.fn(async () => failed('归档不可用')) })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('归档不可用')
    cleanup()

    mount({ items: [summary('甲')], openArchive: vi.fn(async () => { throw new Error('连接中断') }) })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('连接中断')
    cleanup()

    mount({ items: [summary('甲')], openArchive: vi.fn(async () => { throw '原始错误' }) })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('原始错误')
  })

  it('maps every user content block shape to preview text', async () => {
    const circular: Record<string, unknown> = { type: 'loop' }
    circular.self = circular
    const content = [
      { type: 'text', text: '你好' },
      { type: 'reasoning', text: '想一想' },
      { type: 'tool-call', name: 'read', arguments: { file: 'a' } },
      { type: 'tool-call', name: 'write' },
      { type: 'tool-result', content: [{ type: 'text', text: '输出' }, { type: 'image', source: 'x' }] },
      { type: 'tool-result', content: 'raw' },
      { type: 'image', source: 'shot' },
      { type: 'emoji', face: '🎉' },
      'bare',
      null,
      5,
      { type: 'text', text: 7 },
      circular,
    ]
    mount({ items: [summary('甲')], openArchive: vi.fn(async () => okOpen('甲', [userNode(1, content)])) })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => {
      expect(exactText([
        '你好',
        '想一想',
        '调用 read\n{\n  "file": "a"\n}',
        '调用 write\n""',
        '输出\n\n[图片]',
        '"raw"',
        '[图片]',
        '{\n  "type": "emoji",\n  "face": "🎉"\n}',
        '"bare"',
        'null',
        '5',
        '[object Object]',
      ].join('\n\n'))).toBeTruthy()
    })
    expect(within(previewDialog()).getByText('你')).toBeTruthy()
  })

  it('maps steering, assistant, tool, and record nodes with their roles', async () => {
    const nodes = [
      userNode(1, [{ type: 'text', text: '驾驶' }], 'steering'),
      assistantNode(2, [
        { kind: 'text', text: '回答正文' },
        { kind: 'reasoning', text: '推理' },
        { kind: 'tool-call', callId: 'c1', name: 'run', argsRaw: '{"x":1}' },
        { kind: 'image', attachment: 'a1' },
        { kind: 'other', block: { custom: true } },
        { kind: 'text', text: '' },
      ]),
      toolResultNode(3, [{ type: 'text', text: '工具输出' }]),
      { kind: 'turn-error', seq: 4, time: 1, turn: 1, step: 0, message: '轮次失败' },
      { kind: 'turn-max-tokens', seq: 5, time: 1, turn: 1, step: 0 },
      { kind: 'model-retry', seq: 6, time: 1, retryState: 'waiting', attempt: 1 },
      { kind: 'command', seq: 7, time: 1, commandId: 'cmd', name: 'run', args: {}, outcome: { ok: true } },
      { kind: 'compaction', seq: 8, time: 1, summary: '压缩', summaryEventSeq: 0, shadowedItemCount: 0, shadowedTokenCount: 0 },
      { kind: 'unknown', seq: 9, time: 1, type: 'mystery', data: { a: 1 } },
      contextNode(10),
      userNode(11, [{ type: 'text', text: '' }]),
    ]
    mount({ items: [summary('甲')], openArchive: vi.fn(async () => okOpen('甲', nodes)) })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => { expect(screen.getByText('驾驶')).toBeTruthy() })

    const dialog = previewDialog()
    expect(within(dialog).getByText('你')).toBeTruthy()
    expect(within(dialog).getAllByText('助手')).toHaveLength(1)
    expect(within(dialog).getAllByText('工具')).toHaveLength(1)
    expect(within(dialog).getAllByText('记录')).toHaveLength(6)
    expect(within(dialog).getByText('回答正文')).toBeTruthy()
    expect(within(dialog).getByText('推理')).toBeTruthy()
    expect(dialog.textContent).toContain('调用 run')
    expect(dialog.textContent).toContain('{"x":1}')
    expect(dialog.textContent).toContain('"custom": true')
    expect(within(dialog).getAllByText('[图片]')).toHaveLength(1)
    expect(within(dialog).getByText('工具输出')).toBeTruthy()
    const records = [...dialog.querySelectorAll('pre')]
      .map(pre => pre.textContent ?? '')
      .filter(text => text.includes('"kind"'))
    expect(records).toHaveLength(6)
    expect(records[0]).toContain('"kind": "turn-error"')
    expect(records[0]).toContain('轮次失败')
    expect(records[1]).toContain('"kind": "turn-max-tokens"')
    expect(records[2]).toContain('"kind": "model-retry"')
    expect(records[3]).toContain('"kind": "command"')
    expect(records[4]).toContain('"kind": "compaction"')
    expect(records[5]).toContain('"kind": "unknown"')
    expect(within(dialog).getAllByRole('article')).toHaveLength(1 + 1 + 1 + 6)
  })

  it('drops nodes without displayable text into the no-messages state', async () => {
    mount({ items: [summary('甲')], openArchive: vi.fn(async () => okOpen('甲', [contextNode(1), userNode(2, [{ type: 'text', text: '' }])])) })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => { expect(screen.getByText('这个会话没有可显示的消息。')).toBeTruthy() })
  })

  it('loads older pages on demand and reports both result arms', async () => {
    const loadArchiveOlder = vi.fn()
      .mockResolvedValueOnce(okOpen('甲', [userNode(2, [{ type: 'text', text: '更早' }])]))
      .mockResolvedValueOnce(failed('翻页失败'))
    mount({
      items: [summary('甲')],
      openArchive: vi.fn(async () => okOpen('甲', [userNode(1, [{ type: 'text', text: '最新' }])], true)),
      loadArchiveOlder,
    })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => { expect(screen.getByText('最新')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '加载更早消息' }))
    expect(loadArchiveOlder).toHaveBeenCalledWith(sid('甲'))
    await waitFor(() => {
      expect(screen.getByText('更早')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '加载更早消息' })).toBeNull()
    })
    cleanup()

    mount({
      items: [summary('甲')],
      openArchive: vi.fn(async () => okOpen('甲', [userNode(1, [{ type: 'text', text: '最新' }])], true)),
      loadArchiveOlder,
    })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '加载更早消息' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '加载更早消息' }))
    expect((await screen.findByRole('alert')).textContent).toBe('翻页失败')
  })

  it('restores from the footer: success closes, failures surface, and an in-flight action gates closing', async () => {
    let resolveRestore!: () => void
    const unarchiveSession = vi.fn(() => new Promise<void>((resolve) => { resolveRestore = resolve }))
    mount({
      items: [summary('甲')],
      openArchive: vi.fn(async () => okOpen('甲', [userNode(1, [{ type: 'text', text: '正文' }])])),
      unarchiveSession,
    })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => { expect(screen.getByText('正文')).toBeTruthy() })

    const restoreButton = within(previewDialog()).getByRole('button', { name: '取消归档' })
    fireEvent.click(restoreButton)
    expect(unarchiveSession).toHaveBeenCalledWith(sid('甲'))
    const restoreAfterClick = within(previewDialog()).getByRole('button', { name: '取消归档' }) as HTMLButtonElement
    expect(restoreAfterClick.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()

    await act(async () => { resolveRestore() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    cleanup()

    mount({
      items: [summary('甲')],
      openArchive: vi.fn(async () => okOpen('甲', [userNode(1, [{ type: 'text', text: '正文' }])])),
      unarchiveSession: vi.fn(() => new Promise<void>(() => {})),
    })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => { expect(screen.getByText('正文')).toBeTruthy() })
    fireEvent.click(within(previewDialog()).getByRole('button', { name: '取消归档' }))
    const mask = previewDialog().parentElement!.firstElementChild!
    fireEvent.click(mask)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    cleanup()

    mount({
      items: [summary('甲')],
      openArchive: vi.fn(async () => okOpen('甲', [userNode(1, [{ type: 'text', text: '正文' }])])),
      unarchiveSession: vi.fn(async () => { throw new Error('恢复失败') }),
    })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => { expect(screen.getByText('正文')).toBeTruthy() })
    fireEvent.click(within(previewDialog()).getByRole('button', { name: '取消归档' }))
    expect((await screen.findByRole('alert')).textContent).toBe('恢复失败')
    expect(screen.getByRole('dialog')).toBeTruthy()
    cleanup()

    mount({
      items: [summary('甲')],
      openArchive: vi.fn(async () => okOpen('甲', [userNode(1, [{ type: 'text', text: '正文' }])])),
      unarchiveSession: vi.fn(async () => { throw '非错误' }),
    })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => { expect(screen.getByText('正文')).toBeTruthy() })
    fireEvent.click(within(previewDialog()).getByRole('button', { name: '取消归档' }))
    expect((await screen.findByRole('alert')).textContent).toBe('非错误')
  })

  it('restores from a row button, keeping the preview open only for failures', async () => {
    const unarchiveSession = vi.fn(async () => {})
    mount({ items: [summary('甲')], unarchiveSession })
    fireEvent.click(screen.getAllByRole('button', { name: '取消归档' })[0]!)
    expect(unarchiveSession).toHaveBeenCalledWith(sid('甲'))
    await act(async () => { await Promise.resolve() })
    expect(within(screen.getByRole('dialog')).getByText('甲')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()

    cleanup()
    mount({ items: [summary('甲')], unarchiveSession: vi.fn(async () => { throw new Error('行内恢复失败') }) })
    fireEvent.click(screen.getAllByRole('button', { name: '取消归档' })[0]!)
    expect((await screen.findByRole('alert')).textContent).toBe('行内恢复失败')
    expect(screen.getByRole('dialog')).toBeTruthy()
    cleanup()

    mount({ items: [summary('甲')], unarchiveSession: vi.fn(async () => { throw '非错误' }) })
    fireEvent.click(screen.getAllByRole('button', { name: '取消归档' })[0]!)
    expect((await screen.findByRole('alert')).textContent).toBe('非错误')
  })
})

describe('ArchivePanel deletion', () => {
  it('deletes the previewed session from the preview footer and closes both surfaces', async () => {
    const deleteSession = vi.fn(async () => okDelete)
    mount({
      items: [summary('甲')],
      openArchive: vi.fn(async () => okOpen('甲', [userNode(1, [{ type: 'text', text: '正文' }])])),
      deleteSession,
    })
    fireEvent.click(screen.getByRole('button', { name: /甲/ }))
    await waitFor(() => { expect(screen.getByText('正文')).toBeTruthy() })
    fireEvent.click(within(previewDialog()).getByRole('button', { name: '永久删除' }))
    expect(screen.getByText('将永久删除 1 个会话及其消息，无法恢复。')).toBeTruthy()
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: '永久删除' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(deleteSession).toHaveBeenCalledWith(sid('甲'))
  })

  it('cancels the confirm dialog without deleting', () => {
    mount({ items: [summary('甲')] })
    fireEvent.click(screen.getByLabelText('选择归档会话“甲”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('已选择 1 个')).toBeTruthy()
  })

  it('dismisses the confirm dialog through the modal surface while keeping the selection', () => {
    mount({ items: [summary('甲')] })
    fireEvent.click(screen.getByLabelText('选择归档会话“甲”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('已选择 1 个')).toBeTruthy()
    cleanup()

    mount({ items: [summary('甲')] })
    fireEvent.click(screen.getByLabelText('选择归档会话“甲”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    const mask = screen.getByRole('dialog').parentElement!.firstElementChild!
    fireEvent.click(mask)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('已选择 1 个')).toBeTruthy()
  })

  it('orders a selected chain deepest-first and terminates on parent cycles', async () => {
    const chain = mount({
      items: [
        summary('c0'), summary('c1', { parentId: sid('c0') }), summary('c2', { parentId: sid('c1') }),
      ],
    })
    for (const name of ['c0', 'c1', 'c2']) fireEvent.click(screen.getByLabelText(`选择归档会话“${name}”`))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '永久删除' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(vi.mocked(chain.props.deleteSession).mock.calls.map(call => call[0])).toEqual([sid('c2'), sid('c1'), sid('c0')])
    cleanup()

    const unselectedParent = mount({ items: [summary('c0'), summary('c1', { parentId: sid('c0') })] })
    fireEvent.click(screen.getByLabelText('选择归档会话“c1”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '永久删除' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(vi.mocked(unselectedParent.props.deleteSession).mock.calls.map(call => call[0])).toEqual([sid('c1')])
    cleanup()

    const cyclic = mount({ items: [summary('x', { parentId: sid('y') }), summary('y', { parentId: sid('x') })] })
    fireEvent.click(screen.getByLabelText('选择归档会话“x”'))
    fireEvent.click(screen.getByLabelText('选择归档会话“y”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '永久删除' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(vi.mocked(cyclic.props.deleteSession).mock.calls.map(call => call[0])).toEqual([sid('x'), sid('y')])
  })

  it('clears the selection after a successful batch and keeps the dialog on failures', async () => {
    mount({
      items: [summary('甲', { displayTitle: '标题甲' }), summary('乙', { displayTitle: '标题乙' })],
      deleteSession: vi.fn()
        .mockResolvedValueOnce(okDelete)
        .mockResolvedValueOnce(failed('删除失败')),
    })
    fireEvent.click(screen.getByLabelText('选择归档会话“标题甲”'))
    fireEvent.click(screen.getByLabelText('选择归档会话“标题乙”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '永久删除' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('标题乙: 删除失败')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('已选择 1 个')).toBeTruthy()
    cleanup()

    const pruned = mount({
      items: [summary('乙')],
      deleteSession: vi.fn(async () => failed('会话不存在')),
    })
    fireEvent.click(screen.getByLabelText('选择归档会话“乙”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    pruned.rerender({ items: [] })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '永久删除' }))
    expect((await screen.findByRole('alert')).textContent).toBe('乙: 会话不存在')
  })

  it('surfaces rejecting delete calls for Error and non-Error causes', async () => {
    mount({ items: [summary('甲')], deleteSession: vi.fn(async () => { throw new Error('连接断开') }) })
    fireEvent.click(screen.getByLabelText('选择归档会话“甲”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '永久删除' }))
    expect((await screen.findByRole('alert')).textContent).toBe('连接断开')
    expect(screen.queryByRole('dialog')).toBeTruthy()
    cleanup()

    mount({ items: [summary('甲')], deleteSession: vi.fn(async () => { throw '拒绝' }) })
    fireEvent.click(screen.getByLabelText('选择归档会话“甲”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '永久删除' }))
    expect((await screen.findByRole('alert')).textContent).toBe('拒绝')
  })

  it('guards the confirm surface while a batch is in flight', async () => {
    let resolveDelete!: () => void
    const deleteSession = vi.fn(() => new Promise<typeof okDelete>((resolve) => { resolveDelete = () => { resolve(okDelete) } }))
    mount({ items: [summary('甲')], deleteSession })
    fireEvent.click(screen.getByLabelText('选择归档会话“甲”'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '永久删除' }))

    expect(screen.getByText('正在删除…')).toBeTruthy()
    const cancelButton = within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }) as HTMLButtonElement
    expect(cancelButton.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByText('正在删除…'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect(deleteSession).toHaveBeenCalledTimes(1)

    await act(async () => { resolveDelete() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.getByText('已选择 0 个')).toBeTruthy()
  })
})
