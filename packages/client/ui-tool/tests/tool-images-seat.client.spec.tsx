// @vitest-environment jsdom
/**
 * The details result-image seat: ToolDetails routes its gallery through the
 * declared seat when one is bound, renders the shared gallery directly
 * otherwise, and the shipped occupant registers at priority 100 over the
 * real registry — lower priority shadows, disposal restores, fiber teardown
 * clears.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import { apply } from '../src/client/apply.ts'
import { ToolDetails } from '../src/client/tool/ToolDetails.tsx'
import { ToolImagesDefault } from '../src/client/tool/ToolImagesDefault.tsx'

const t = makeTranslate(zh, commonZh) as never

const image: ImageAttachmentRef = {
  attachmentId: AttachmentId('a'),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
  name: 'shot.png',
}

const settled: ToolResultNode = {
  kind: 'tool-result',
  seq: 10,
  time: 2_000,
  callId: 'c1',
  content: [{ type: 'image', attachment: image }],
  isError: false,
} as unknown as ToolResultNode

afterEach(cleanup)

describe('ToolDetails seat routing', () => {
  it('routes the result gallery through the declared seat with the owner share', () => {
    const owners: { images: readonly ImageAttachmentRef[]; load: (a: ImageAttachmentRef) => Promise<string> }[] = []
    const load = () => Promise.resolve('blob:m')
    render(
      <ToolDetails block={settled} loadModelImage={load} t={t} renderSlot={((key: string, owner: never) => {
        expect(key).toBe('conversation.details.tool.images')
        owners.push(owner)
        return <mark>seat</mark>
      }) as never} />,
    )
    expect(screen.getByText('seat')).toBeTruthy()
    expect(owners).toHaveLength(1)
    expect(owners[0]?.images).toEqual([image])
    expect(owners[0]?.load).toBe(load)
  })

  it('renders the shared gallery directly without a bound seat', async () => {
    render(<ToolDetails block={settled} loadModelImage={() => Promise.resolve('blob:m')} t={t} />)
    expect(await screen.findByRole('img', { name: 'shot.png' })).toBeTruthy()
  })

  it('renders the shipped occupant over the owner share', async () => {
    render(<ToolImagesDefault images={[image]} load={() => Promise.resolve('blob:m')} t={t} />)
    expect(await screen.findByRole('img', { name: 'shot.png' })).toBeTruthy()
  })
})

describe('registry wiring', () => {
  async function bench(): Promise<{
    slots: SlotRegistry
    fiber: { dispose: () => Promise<void> }
  }> {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        'conversation.details.tool': { kind: 'single', scope: 'session' },
      },
    } as never, () => null)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: ['slots', 'locale'], apply })
    await fiber.await()
    return { slots, fiber }
  }

  function winnerPriority(slots: SlotRegistry): number | undefined {
    const entries = slots.entriesOfSlot('conversation.details.tool.images' as never)
    expect(entries.length).toBeGreaterThan(0)
    return (entries[0] as { options: { priority?: number } }).options.priority
  }

  it('registers the shipped occupant at priority 100 and tears down with the fiber', async () => {
    const { slots, fiber } = await bench()
    expect(winnerPriority(slots)).toBe(100)
    const dispose = slots.register(
      { name: 'conversation.details.tool.images', priority: 0 } as never,
      () => null as unknown as ReactNode,
    )
    expect(winnerPriority(slots)).toBe(0)
    dispose()
    expect(winnerPriority(slots)).toBe(100)
    await fiber.dispose()
    expect(slots.entriesOfSlot('conversation.details.tool.images' as never)).toHaveLength(0)
  })
})
