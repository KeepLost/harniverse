/**
 * Page-level behaviour the controller cannot reach: refusals while the page is
 * closing, metadata patches that change nothing, and a target the browser
 * refuses to close.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CdpConnection, CdpEvent } from '../src/cdp.ts'
import { HostBrowserPage } from '../src/page.ts'
import type { BrowserAttachmentId, BrowserFrame, HostBrowserPageId } from '../src/types.ts'

const attachmentId = 'att-one' as BrowserAttachmentId

/** A connection stub recording commands and replaying scripted replies. */
function stubConnection() {
  const commands: { method: string; params: Record<string, unknown> }[] = []
  const listeners = new Set<(event: CdpEvent) => void>()
  const replies = new Map<string, Record<string, unknown> | Error>()
  const connection = {
    send: vi.fn((method: string, params: Record<string, unknown> = {}) => {
      commands.push({ method, params })
      const reply = replies.get(method)
      if (reply instanceof Error) return Promise.reject(reply)
      return Promise.resolve(reply ?? {})
    }),
    on: (listener: (event: CdpEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: vi.fn(),
  }
  return {
    connection: connection as unknown as CdpConnection,
    commands,
    replies,
    listeners,
    emit: (event: CdpEvent) => { for (const listener of [...listeners]) listener(event) },
  }
}

/**
 * Build a started page with one controlling attachment.
 * @returns the page, its stub connection, and the attached stream.
 */
async function started() {
  const stub = stubConnection()
  const page = new HostBrowserPage(stub.connection, {
    id: 'page-one' as HostBrowserPageId,
    targetId: 'target-1',
    sessionId: 'flat-session',
    width: 800,
    height: 600,
    screencast: { quality: 50, everyNthFrame: 1 },
    policy: { allowedHosts: [], allowPrivateAddresses: true },
    navigationTimeoutMs: 1000,
  })
  await page.start()
  const abort = new AbortController()
  const stream = page.follow(attachmentId, abort.signal)[Symbol.asyncIterator]()
  const baseline = (await stream.next()).value as BrowserFrame
  return { ...stub, page, stream, abort, baseline }
}

/**
 * Assert that no further frame arrives, then close the attachment so the
 * pending read settles (an in-flight `next()` would otherwise deadlock the
 * generator's own `return()`).
 * @param stream - the attachment iterator.
 * @param abort - the attachment lifetime.
 * @returns true when the attachment ended without another frame.
 */
async function noFrame(
  stream: AsyncIterator<BrowserFrame>, abort: AbortController,
): Promise<boolean> {
  const pending = stream.next()
  await new Promise(resolve => setTimeout(resolve, 20))
  abort.abort()
  return (await pending).done === true
}

describe('HostBrowserPage', () => {
  it('refuses control while the page is closing', async () => {
    const { page, stream, replies } = await started()
    replies.set('Target.closeTarget', new Error('the target is hung'))
    const closing = page.close()
    await expect(page.navigate(attachmentId, 'https://example.com')).rejects.toMatchObject({
      code: 'browser-control-unavailable',
      details: { reason: 'not-running' },
      message: 'The page is not available',
    })
    // The failed close stays retryable: a second call reaches the browser again.
    await expect(closing).rejects.toThrow('the target is hung')
    replies.delete('Target.closeTarget')
    await expect(page.close()).resolves.toBeUndefined()
    await stream.return?.()
  })

  it('broadcasts nothing when an observed patch changes no metadata', async () => {
    const { page, emit, stream, abort } = await started()
    emit({ method: 'Page.frameStartedLoading', params: {}, sessionId: 'flat-session' })
    expect((await stream.next()).value).toMatchObject({ type: 'state', info: { loading: true } })
    emit({ method: 'Page.frameStartedLoading', params: {}, sessionId: 'flat-session' })
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'target-1' } } })
    expect(await noFrame(stream, abort)).toBe(true)
    expect(page.info.loading).toBe(true)
  })

  it('ignores a screencast frame with no image data and an unparsable ack', async () => {
    const { page, emit, stream } = await started()
    emit({ method: 'Page.screencastFrame', params: { metadata: {} }, sessionId: 'flat-session' })
    emit({ method: 'Page.screencastFrame', params: { data: 'aGk=', metadata: {} }, sessionId: 'flat-session' })
    expect((await stream.next()).value).toEqual({ type: 'image', image: { data: 'aGk=', width: 800, height: 600 } })
    expect(page.info.width).toBe(800)
    await stream.return?.()
  })

  it('ignores observed payloads it cannot read: no frame, no url, no metadata, no ack', async () => {
    const { page, emit, stream, abort } = await started()
    emit({ method: 'Page.frameNavigated', params: {}, sessionId: 'flat-session' })
    emit({ method: 'Page.frameNavigated', params: { frame: {} }, sessionId: 'flat-session' })
    emit({ method: 'Page.navigatedWithinDocument', params: {}, sessionId: 'flat-session' })
    emit({ method: 'Target.targetInfoChanged', params: {} })
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'target-1', url: 'about:blank', title: 7 } } })
    emit({ method: 'Page.screencastFrame', params: { data: 'bm9uZQ==' }, sessionId: 'flat-session' })
    expect((await stream.next()).value).toEqual({ type: 'image', image: { data: 'bm9uZQ==', width: 800, height: 600 } })
    expect(page.info).toMatchObject({ url: '', title: '' })
    expect(await noFrame(stream, abort)).toBe(true)
  })

  it('ignores protocol events for another page session', async () => {
    const { emit, stream, page, abort } = await started()
    emit({ method: 'Page.screencastFrame', params: { data: 'bm8=', metadata: {} }, sessionId: 'other' })
    emit({ method: 'Page.unrelatedEvent', params: {}, sessionId: 'flat-session' })
    expect(await noFrame(stream, abort)).toBe(true)
    expect(page.info.url).toBe('')
  })
})
