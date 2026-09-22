/** The collapsing follower queue: newest value per kind, bounded by construction. */
import { describe, expect, it } from 'vitest'
import { BrowserFollower } from '../src/stream.ts'
import type { BrowserFrame, HostBrowserPageId, HostBrowserPageInfo } from '../src/types.ts'

const info = (title: string): HostBrowserPageInfo => ({
  id: 'page-1' as HostBrowserPageId,
  url: 'https://example.com',
  title,
  width: 800,
  height: 600,
  loading: false,
  state: 'ready',
  canGoBack: false,
  canGoForward: false,
})

const image = (data: string): BrowserFrame => ({ type: 'image', image: { data, width: 800, height: 600 } })

/**
 * Drain one follower to completion.
 * @param follower - the follower to read.
 * @param signal - read cancellation.
 * @returns every delivered frame.
 */
async function drain(follower: BrowserFollower, signal: AbortSignal): Promise<BrowserFrame[]> {
  const frames: BrowserFrame[] = []
  for await (const frame of follower.read(signal)) frames.push(frame)
  return frames
}

describe('BrowserFollower', () => {
  it('delivers queued frames in order and finishes', async () => {
    const follower = new BrowserFollower()
    follower.push({ type: 'snapshot', info: info('one') })
    follower.push(image('a'))
    follower.finish()
    expect(await drain(follower, new AbortController().signal)).toEqual([
      { type: 'snapshot', info: info('one') },
      image('a'),
    ])
  })

  it('collapses a pending image onto the newest one', async () => {
    const follower = new BrowserFollower()
    follower.push(image('stale'))
    follower.push(image('stale-2'))
    follower.push(image('fresh'))
    follower.finish()
    expect(await drain(follower, new AbortController().signal)).toEqual([image('fresh')])
  })

  it('collapses a pending state frame onto the newest metadata', async () => {
    const follower = new BrowserFollower()
    follower.push({ type: 'state', info: info('old') })
    follower.push({ type: 'state', info: info('new') })
    follower.finish()
    expect(await drain(follower, new AbortController().signal)).toEqual([{ type: 'state', info: info('new') }])
  })

  it('keeps one image and one state frame side by side', async () => {
    const follower = new BrowserFollower()
    follower.push({ type: 'state', info: info('meta') })
    follower.push(image('pixels'))
    follower.push({ type: 'state', info: info('meta-2') })
    follower.push(image('pixels-2'))
    follower.finish()
    expect(await drain(follower, new AbortController().signal)).toEqual([
      { type: 'state', info: info('meta-2') },
      image('pixels-2'),
    ])
  })

  it('wakes a waiting reader when a frame arrives', async () => {
    const follower = new BrowserFollower()
    const reading = drain(follower, new AbortController().signal)
    await Promise.resolve()
    follower.push(image('late'))
    follower.finish()
    expect(await reading).toEqual([image('late')])
  })

  it('stops on abort and drops the queue', async () => {
    const follower = new BrowserFollower()
    const abort = new AbortController()
    const reading = drain(follower, abort.signal)
    await Promise.resolve()
    follower.push(image('never-delivered'))
    abort.abort()
    expect(await reading).toEqual([])
  })

  it('yields nothing when the signal aborted before the read', async () => {
    const follower = new BrowserFollower()
    const abort = new AbortController()
    abort.abort()
    follower.push(image('never-delivered'))
    expect(await drain(follower, abort.signal)).toEqual([])
  })

  it('ignores pushes after close and after finish', async () => {
    const closed = new BrowserFollower()
    closed.close()
    closed.push(image('ignored'))
    expect(await drain(closed, new AbortController().signal)).toEqual([])
    const finished = new BrowserFollower()
    finished.finish()
    finished.push(image('ignored'))
    expect(await drain(finished, new AbortController().signal)).toEqual([])
  })
})
