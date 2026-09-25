/** The CDP transport: handshake, command correlation, event delivery, and failure propagation. */
import { describe, expect, it, vi } from 'vitest'
import { CdpConnection, CdpError, type CdpEvent } from '../src/cdp.ts'
import { startFakeBrowser } from './fake-browser.ts'

describe('CdpConnection', () => {
  it('correlates replies to their commands over a real socket', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      browser.replies.set('Browser.getVersion', () => ({ product: 'FakeChrome/1.0' }))
      expect(await connection.send('Browser.getVersion')).toEqual({ product: 'FakeChrome/1.0' })
      expect(await connection.send('Page.enable', {}, 'flat-session')).toEqual({})
      expect(browser.commands.at(-1)).toMatchObject({ method: 'Page.enable', sessionId: 'flat-session' })
      connection.close()
    } finally {
      await browser.close()
    }
  })

  it('surfaces a protocol error reply as a CdpError carrying its code', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      browser.failures.set('Page.navigate', 'Cannot navigate to invalid URL')
      const failure = await connection.send('Page.navigate').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(CdpError)
      expect(failure).toMatchObject({ name: 'CdpError', code: -32000 })
      expect((failure as Error).message).toBe('Page.navigate failed: Cannot navigate to invalid URL')
      connection.close()
    } finally {
      await browser.close()
    }
  })

  it('delivers events to every listener until it unsubscribes', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      const seen: CdpEvent[] = []
      const stop = connection.on((event) => { seen.push(event) })
      browser.emit('Page.loadEventFired', { timestamp: 1 }, 'flat-session')
      browser.emit('Target.targetCreated', { targetInfo: { targetId: 'a' } })
      await waitFor(() => seen.length === 2)
      expect(seen).toEqual([
        { method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'flat-session' },
        { method: 'Target.targetCreated', params: { targetInfo: { targetId: 'a' } } },
      ])
      stop()
      browser.emit('Page.loadEventFired', {}, 'flat-session')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(seen).toHaveLength(2)
      connection.close()
    } finally {
      await browser.close()
    }
  })

  it('ignores frames it cannot correlate: malformed JSON, unknown ids, and method-less messages', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      const seen: CdpEvent[] = []
      connection.on((event) => { seen.push(event) })
      browser.raw('{not json')
      browser.raw(JSON.stringify({ id: 9999, result: {} }))
      browser.raw(JSON.stringify({ params: {} }))
      browser.raw(JSON.stringify({ method: 'Page.ready' }))
      await waitFor(() => seen.length === 1)
      expect(seen).toEqual([{ method: 'Page.ready', params: {} }])
      // The connection still works after the garbage.
      expect(await connection.send('Page.enable')).toEqual({})
      connection.close()
    } finally {
      await browser.close()
    }
  })

  it('rejects when the endpoint refuses the connection', async () => {
    const browser = await startFakeBrowser()
    const endpoint = browser.endpoint
    await browser.close()
    await expect(CdpConnection.open(endpoint, new AbortController().signal))
      .rejects.toThrow(`DevTools connection to ${endpoint} failed during handshake`)
  })

  it('rejects when the handshake is aborted', async () => {
    const browser = await startFakeBrowser()
    try {
      const abort = new AbortController()
      const opening = CdpConnection.open(browser.endpoint, abort.signal)
      abort.abort()
      await expect(opening).rejects.toThrow('DevTools connection was aborted')
    } finally {
      await browser.close()
    }
  })

  it('does not open a socket for an already-aborted handshake', async () => {
    const abort = new AbortController()
    abort.abort(new Error('request cancelled'))
    await expect(CdpConnection.open('ws://127.0.0.1:1/devtools/browser/fake', abort.signal))
      .rejects.toThrow('request cancelled')
  })

  it('normalizes a non-Error abort before opening a socket', async () => {
    const abort = new AbortController()
    abort.abort('left')
    await expect(CdpConnection.open('ws://127.0.0.1:1', abort.signal))
      .rejects.toThrow('DevTools connection was aborted')
  })

  it('reports a socket closing during the handshake without calling it a refusal', async () => {
    const sockets: EventTarget[] = []
    vi.stubGlobal('WebSocket', class extends EventTarget {
      constructor(_endpoint: string) { super(); sockets.push(this) }
      close(): void {}
    })
    try {
      const opening = CdpConnection.open('ws://localhost/devtools', new AbortController().signal)
      sockets[0]?.dispatchEvent(new Event('close'))
      await expect(opening).rejects.toThrow('closed during handshake')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('handles an abort during socket construction', async () => {
    const abort = new AbortController()
    const close = vi.fn()
    vi.stubGlobal('WebSocket', class extends EventTarget {
      constructor(_endpoint: string) { super(); abort.abort(new Error('caller left')) }
      close(): void { close() }
    })
    try {
      await expect(CdpConnection.open('ws://localhost/devtools', abort.signal))
        .rejects.toThrow('DevTools connection was aborted')
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails every in-flight command when the browser drops the socket', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      browser.silent.add('Page.captureScreenshot')
      const pending = connection.send('Page.captureScreenshot').catch((error: unknown) => (error as Error).message)
      browser.drop()
      expect(await pending).toBe('DevTools connection closed')
      // A later command fails immediately with the recorded failure.
      await expect(connection.send('Page.enable')).rejects.toThrow('DevTools connection closed')
    } finally {
      await browser.close()
    }
  })

  it('ignores binary frames, which the protocol never uses', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      const seen: CdpEvent[] = []
      connection.on((event) => { seen.push(event) })
      browser.binary(new Uint8Array([1, 2, 3]))
      browser.emit('Page.ready', {})
      await waitFor(() => seen.length === 1)
      expect(seen).toEqual([{ method: 'Page.ready', params: {} }])
      connection.close()
    } finally {
      await browser.close()
    }
  })

  it('reports a protocol error that carries neither code nor message', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      browser.vagueFailures.add('Page.navigate')
      const failure = await connection.send('Page.navigate').catch((error: unknown) => error)
      expect(failure).toMatchObject({ name: 'CdpError', code: 0 })
      expect((failure as Error).message).toBe('Page.navigate failed: unknown protocol error')
      connection.close()
    } finally {
      await browser.close()
    }
  })

  it('treats a reply with no result as an empty result', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      browser.bare.add('Page.enable')
      expect(await connection.send('Page.enable')).toEqual({})
      connection.close()
    } finally {
      await browser.close()
    }
  })

  it('fails in-flight commands when the socket errors instead of closing cleanly', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      browser.silent.add('Page.captureScreenshot')
      const pending = connection.send('Page.captureScreenshot').catch((error: unknown) => (error as Error).message)
      browser.kill()
      // Either the transport error or the close arrives first; both are terminal.
      expect(await pending).toMatch(/^DevTools connection (failed|closed)$/u)
    } finally {
      await browser.close()
    }
  })

  it('refuses commands after the host closes the connection', async () => {
    const browser = await startFakeBrowser()
    try {
      const connection = await CdpConnection.open(browser.endpoint, new AbortController().signal)
      connection.close()
      connection.close()
      await expect(connection.send('Page.enable')).rejects.toThrow('DevTools connection was closed by the host')
    } finally {
      await browser.close()
    }
  })
})

/**
 * Poll one predicate until it holds.
 * @param predicate - condition to await.
 * @returns when the predicate holds.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was never met')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
