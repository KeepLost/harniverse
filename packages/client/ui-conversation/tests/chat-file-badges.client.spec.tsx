// @vitest-environment jsdom
// User-message file badges: the pinned handle-text suppression/recovery
// helper, the badge row on user and steering bubbles (structured refs first,
// handle-text recovery as the fallback), and the messageDefinition.start
// projection carrying event-source files into the node state.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { UserMessageNodeView, PendingSteeringBubble } from '../src/client/chat/MessageItem.tsx'
import { splitFileHandleText } from '../src/client/chat/file-badges.ts'
import { messageDefinition } from '../src/client/conversation-nodes/message.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)

function ref(seed: string, bytes: number, name?: string): FileAttachmentRef {
  return {
    attachmentId: `sha256:${seed.repeat(64).slice(0, 64)}` as FileAttachmentRef['attachmentId'],
    bytes,
    ...(name === undefined ? {} : { name }),
  }
}

function handleText(seed: string, bytes: number, name: string) {
  const sha8 = seed.repeat(64).slice(0, 8)
  const human = bytes < 1024
    ? `${bytes} B`
    : bytes < 10 * 1024 ? `${Math.round(bytes / 102.4) / 10} KB` : `${Math.round(bytes / 1024)} KB`
  return `[文件] ${name} · ${human} · sha256:${sha8}\n只读路径: /tmp/attachments/v1/links/${sha8}.bin\n用 read 工具读取该路径获得内容；不要凭名字猜测内容。`
}

describe('splitFileHandleText', () => {
  it('suppresses whole handle blocks and recovers their badge data', () => {
    const { text, badges } = splitFileHandleText([
      { type: 'text', text: handleText('a', 1536, '报告.md') },
      { type: 'text', text: '请阅读以上文件' },
      { type: 'text', text: handleText('b', 12_582_912, 'data.csv') },
    ])
    expect(text).toBe('请阅读以上文件')
    expect(badges).toEqual([
      { name: '报告.md', bytes: 1536 },
      { name: 'data.csv', bytes: 12_582_912 },
    ])
  })

  it('never touches user-typed prose that merely contains the handle head', () => {
    const typed = '[文件] 我自己写的文字\n不是模型句柄'
    const { text, badges } = splitFileHandleText([{ type: 'text', text: typed }])
    expect(text).toBe(typed)
    expect(badges).toEqual([])
  })

  it('passes non-text blocks through untouched', () => {
    const block = { type: 'image', attachment: {} }
    const { text, badges } = splitFileHandleText([block])
    expect(text).toBe('')
    expect(badges).toEqual([])
  })
})

describe('user bubble badges', () => {
  it('renders the structured refs as a badge row and hides the handle text', () => {
    const files = [ref('c', 2048, '笔记.txt')]
    render(
      <UserMessageNodeView
        {...{ node: {
          key: 'k', kind: 'user', id: '1', target: 'chat', anchorSeq: 1,
          location: { kind: 'session' }, visibility: 'visible',
          data: {
            kind: 'user', seq: 1, time: 1,
            content: [
              { type: 'text', text: handleText('c', 2048, '笔记.txt') },
              { type: 'text', text: '帮我总结' },
            ] as never,
            source: null,
            files,
          },
        }, t } as never as ChatNodeViewProps<'user'>}
      />,
    )
    expect(screen.getByText('笔记.txt')).toBeTruthy()
    expect(screen.getByText('2 KB')).toBeTruthy()
    expect(screen.getByText('帮我总结')).toBeTruthy()
    expect(screen.queryByText(/只读路径/)).toBeNull()
    expect(screen.queryByText(/sha256/)).toBeNull()
  })

  it('falls back to handle-text recovery when the refs are absent', () => {
    render(
      <PendingSteeringBubble
        content={[
          { type: 'text', text: handleText('d', 300, '快照.txt') },
          { type: 'text', text: '插话内容' },
        ] as never}
        t={t}
      />,
    )
    expect(screen.getByText('快照.txt')).toBeTruthy()
    expect(screen.getByText('300 B')).toBeTruthy()
    expect(screen.getByText('插话内容')).toBeTruthy()
    expect(screen.queryByText(/只读路径/)).toBeNull()
  })
})

describe('messageDefinition files projection', () => {
  it('carries event-source files into user and steering node state', () => {
    const files = [ref('e', 5, 'e.txt')]
    const start = (claimed: boolean) => messageDefinition.start(
      { key: 'k' } as never,
      {
        event: {
          seq: 2, time: 3, type: 'user/message', surfaceOp: 'append',
          data: { id: 'm1', content: [], source: { kind: 'user', files } },
        },
      } as never,
      { previous: () => (claimed === true ? { state: { claimed: new Set(['m1']) } } : undefined) } as never,
    ) as { kind: string; files?: unknown }

    expect(start(false)).toMatchObject({ kind: 'user', files })
    expect(start(true)).toMatchObject({ kind: 'steering', files })
  })

  it('omits files when the source carries none', () => {
    const state = messageDefinition.start(
      { key: 'k' } as never,
      {
        event: {
          seq: 2, time: 3, type: 'user/message', surfaceOp: 'append',
          data: { id: 'm2', content: [], source: { kind: 'user' } },
        },
      } as never,
      { previous: () => undefined } as never,
    ) as { files?: unknown }
    expect(state.files).toBeUndefined()
    expect('files' in state).toBe(false)
  })
})
