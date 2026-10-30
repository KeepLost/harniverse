// @vitest-environment jsdom
/**
 * Presentation seats over the chat-node entries: the shipped gallery/body
 * occupants, the user-key bridge that declares the user-images seat, the
 * assistant markdown threads, and the registry wiring — defaults at priority
 * 100, a lower-priority replacement shadows one domain only, disposal
 * restores the shipped presentation.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ChatImagesOwnerProps } from '../src/client/contract/slots.ts'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { NS, en, zh } from '../src/client/locales.ts'
import { registerChatNodeRenderers } from '../src/client/chat/register-node-renderers.ts'
import { ChatImagesDefault, ReasoningBodyDefault, UserMessageSeatView } from '../src/client/chat/seat-occupants.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { AssistantSeatView } from '../src/client/chat/seat-occupants.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

const t = makeTranslate(zh, commonZh)

function ref(name: string): ImageAttachmentRef {
  return { attachmentId: AttachmentId(`sha256:${name}`), mediaType: 'image/png', bytes: 8, width: 8, height: 8, name }
}

/** Owner-share and session-kit stubs shared by the seat-bridge mounts. */
const seatStubs = {
  openFile: () => {},
  inspectCall: () => {},
  forkAt: () => {},
  loadModelImage: () => Promise.resolve('blob:m'),
  fileMentions: () => undefined,
  externalLinks: {} as never,
  selectedCallId: undefined,
  cwd: undefined,
  useTurnData: (() => undefined) as never,
  useProjection: (() => undefined) as never,
  useInput: (() => ({})) as never,
  inputActions: {} as never,
  useSession: (() => ({})) as never,
  SessionProvider: (({ children }: { children: (id: never) => unknown }) => children('s1' as never)) as never,
  useSessions: (() => ({})) as never,
  useWorkspaces: (() => ({})) as never,
  sessionId: 's1' as never,
} as const

function userNode(images: readonly ImageAttachmentRef[]): ChatNode<'user'> {
  return {
    kind: 'user',
    key: 'user:1',
    anchorSeq: 1,
    location: { kind: 'turn', turn: { turn: 1 } },
    visibility: 'visible',
    data: { content: images.map(attachment => ({ type: 'image', attachment })), time: '10:00' },
  } as unknown as ChatNode<'user'>
}

afterEach(cleanup)

describe('shipped seat occupants', () => {
  it('renders the gallery through the shared atoms with the owner share', async () => {
    const load = vi.fn(() => Promise.resolve('blob:seat'))
    render(<ChatImagesDefault images={[ref('shot.png')]} load={load} align="end" t={t} />)
    expect(await screen.findByRole('img', { name: 'shot.png' })).toBeTruthy()
    expect(load).toHaveBeenCalledOnce()
  })

  it('renders the reasoning body as the plain pre-wrap text', () => {
    const { container } = render(<ReasoningBodyDefault text="step one" running={false} />)
    expect(container.textContent).toBe('step one')
  })
})

describe('user-key seat bridge', () => {
  it('routes the bubble gallery through the declared seat with the owner share', () => {
    const owners: ChatImagesOwnerProps[] = []
    const load = () => Promise.resolve('blob:x')
    render(
      <UserMessageSeatView
        {...seatStubs}
        node={userNode([ref('a.png'), ref('b.png')])}
        loadImage={load}
        renderSlot={((key: string, owner: ChatImagesOwnerProps) => {
          expect(key).toBe('conversation.chat.user.images')
          owners.push(owner)
          return <span data-testid="seat" />
        }) as never}
        t={t}
      />,
    )
    expect(screen.getByTestId('seat')).toBeTruthy()
    expect(owners).toHaveLength(1)
    expect(owners[0]?.align).toBe('end')
    expect(owners[0]?.images.map(attachment => attachment.name)).toEqual(['a.png', 'b.png'])
    expect(owners[0]?.load).toBe(load)
  })

  it('keeps the seat silent for an imageless message', () => {
    const renderSlot = vi.fn(() => <span />)
    render(
      <UserMessageSeatView
        {...seatStubs}
        node={userNode([])}
        loadImage={() => Promise.resolve('blob:x')}
        renderSlot={renderSlot as never}
        t={t}
      />,
    )
    expect(renderSlot).not.toHaveBeenCalled()
  })
})

describe('assistant node seat threads', () => {
  it('forwards both declared seats from the assistant-step entry', async () => {
    const keys: string[] = []
    const node = {
      kind: 'assistant-step',
      key: 'assistant:1',
      anchorSeq: 1,
      location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } },
      visibility: 'visible',
      data: {
        status: 'settled',
        finalNode: undefined,
        blocks: [
          { kind: 'reasoning', text: 'ponder' },
          { kind: 'image', attachment: ref('mid.png') },
        ],
      },
    } as never
    render(
      <AssistantSeatView
        {...seatStubs}
        node={node}
        loadImage={() => Promise.resolve('blob:n')}
        renderSlot={((key: string) => {
          keys.push(key)
          return <mark>{key}</mark>
        }) as never}
        t={t}
      />,
    )
    expect(screen.getByText('conversation.chat.assistant.images')).toBeTruthy()
    fireEvent.click(screen.getByText('Think'))
    expect(screen.getByText('conversation.chat.reasoning.body')).toBeTruthy()
    expect(keys).toContain('conversation.chat.reasoning.body')
    expect(keys).toContain('conversation.chat.assistant.images')
  })
})

describe('assistant markdown threads', () => {
  const blocks = [
    { kind: 'reasoning', text: 'think it through' },
    { kind: 'image', attachment: ref('out.png') },
  ] as never as Parameters<typeof AssistantMarkdown>[0]['blocks']

  it('renders image groups and reasoning bodies through the seat threads', () => {
    const seen: string[] = []
    const renderImages = (owner: ChatImagesOwnerProps): ReactNode => {
      seen.push(`images:${owner.align}:${owner.images.map(attachment => attachment.name).join(',')}`)
      return <mark>gallery</mark>
    }
    const renderBody = (owner: { text: string; running: boolean }): ReactNode => {
      seen.push(`body:${owner.text}:${String(owner.running)}`)
      return <mark>body</mark>
    }
    const { container } = render(
      <AssistantMarkdown
        blocks={blocks}
        streaming={false}
        loadImage={() => Promise.resolve('blob:y')}
        renderImages={renderImages}
        renderBody={renderBody}
        t={t}
      />,
    )
    // The gallery thread renders in place; the body thread renders inside the
    // disclosure, so it appears once the Think row expands.
    expect(container.querySelectorAll('mark').length).toBe(1)
    expect(seen).toContain('images:start:out.png')
    fireEvent.click(screen.getByText('Think'))
    expect(container.querySelectorAll('mark').length).toBe(2)
    expect(seen).toContain('body:think it through:false')
  })

  it('renders the shared gallery and plain body directly without threads', async () => {
    const { container } = render(
      <AssistantMarkdown
        blocks={blocks}
        streaming={false}
        loadImage={() => Promise.resolve('blob:y')}
        t={t}
      />,
    )
    expect(await screen.findByRole('img', { name: 'out.png' })).toBeTruthy()
    expect(container.textContent).toContain('think it through')
  })
})

describe('registry wiring', () => {
  interface Bench {
    ctx: Context
    slots: SlotRegistry
    fiber: { dispose: () => Promise<void> }
  }

  async function bench(): Promise<Bench> {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, () => null)
    ctx.provide('locale', new LocaleRuntime(ctx))
    ;(ctx.get('locale') as LocaleRuntime).register(NS, { zh, en })
    const fiber = ctx.plugin({
      inject: ['slots'],
      apply: (inner) => { registerChatNodeRenderers(inner) },
    })
    await fiber.await()
    return { ctx, slots, fiber }
  }

  type SeatKey = 'conversation.chat.user.images' | 'conversation.chat.assistant.images' | 'conversation.chat.reasoning.body'

  function winnerOf(slots: SlotRegistry, key: SeatKey): { component: unknown; priority: number | undefined } {
    const entries = slots.entriesOfSlot(key)
    expect(entries.length).toBeGreaterThan(0)
    const entry = entries[0] as { component: unknown; options: { priority?: number } }
    return { component: entry.component, priority: entry.options.priority }
  }

  it('registers the shipped occupants at priority 100 over the declared seats', async () => {
    const { slots, fiber } = await bench()
    const seats: readonly SeatKey[] = [
      'conversation.chat.user.images',
      'conversation.chat.assistant.images',
      'conversation.chat.reasoning.body',
    ]
    for (const key of seats) {
      const winner = winnerOf(slots, key)
      expect(winner.component).toBeTruthy()
      expect(winner.priority).toBe(100)
    }
    await fiber.dispose()
  })

  it('shadows exactly one domain at a lower priority and restores it on disposal', async () => {
    const { slots } = await bench()
    const dispose = slots.register(
      { name: 'conversation.chat.user.images', priority: 0 } as never,
      () => <span>replacement</span>,
    )
    const winner = winnerOf(slots, 'conversation.chat.user.images')
    expect(winner.priority).toBe(0)
    const untouched = winnerOf(slots, 'conversation.chat.assistant.images')
    expect(untouched.priority).toBe(100)
    dispose()
    expect(winnerOf(slots, 'conversation.chat.user.images').priority).toBe(100)
  })

  it('tears every seat and default down with the fiber', async () => {
    const { slots, fiber } = await bench()
    await fiber.dispose()
    expect(slots.entriesOfSlot('conversation.chat.user.images')).toHaveLength(0)
    expect(slots.entriesOfSlot('conversation.chat.node')).toHaveLength(0)
  })
})
