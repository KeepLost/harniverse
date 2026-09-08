// Upload transport: the XHR carrier's header shaping (URI-encoded name, bare
// MIME), progress forwarding, the route error-body mapping, abort bridging,
// and receipt validation — over a fake XMLHttpRequest so every settle path is
// driven deterministically. The fixture-world half covers receipt minting and
// prompt admission parity.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebFileUploadTransport, FileUploadError } from '../src/client/upload.ts'
import type { FileUploadHooks, FileUploadRequest } from '../src/client/upload.ts'
import { createFixtureFaces } from '../src/client/fixture.ts'
import { RpcId } from '../src/client/api.ts'
import type { RpcRequest } from '../src/client/api.ts'

/** Test-side rpc request mint (the fixture's module-private helper stays private). */
function req<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(crypto.randomUUID()), payload }
}

/** Deterministic fake XHR: instance list + a script the test drives by hand. */
class FakeXhr {
  static instances: FakeXhr[] = []
  static open = vi.fn()
  static send = vi.fn()
  static reset(): void {
    FakeXhr.instances = []
    FakeXhr.open.mockReset()
    FakeXhr.send.mockReset()
  }

  status = 0
  responseText = ''
  upload = {
    onprogress: null as ((event: { loaded: number; total: number }) => void) | null,
  }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  aborted = false

  constructor() {
    FakeXhr.instances.push(this)
  }

  open(method: string, url: string): void {
    FakeXhr.open(method, url)
  }
  setRequestHeader = vi.fn()
  getResponseHeader = vi.fn().mockReturnValue(null)
  send(body: unknown): void {
    void body
    FakeXhr.send(body)
  }
  abort(): void {
    this.aborted = true
    this.onabort?.()
  }
}

const BASE = 'http://dsh.test'

function transport() {
  return createWebFileUploadTransport(() => BASE)
}

function request(over: Partial<FileUploadRequest> = {}): FileUploadRequest {
  return { data: new Blob([new Uint8Array(8)]), name: '笔记.txt', mediaType: 'text/plain', ...over }
}

function hooks(over: Partial<FileUploadHooks> = {}): FileUploadHooks {
  return over
}

afterEach(() => {
  FakeXhr.reset()
  vi.unstubAllGlobals()
})

describe('web upload transport', () => {
  it('does not replay when the authentication owner stops during the status check', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    let stopped = false
    const auth = {
      ready: async () => { if (stopped) throw new Error('authentication stopped') },
      check: async () => { stopped = true },
      requireRefresh: vi.fn(),
    }
    const pending = createWebFileUploadTransport(() => BASE, auth)(request())
    const result = expect(pending).rejects.toThrow('authentication stopped')
    await Promise.resolve()
    const xhr = FakeXhr.instances[0]!
    xhr.status = 401
    xhr.getResponseHeader.mockReturnValue('required')
    xhr.onload!()
    await vi.waitFor(() => { expect(stopped).toBe(true) })
    expect(FakeXhr.instances).toHaveLength(1)
    await result
  })

  it.each([200, 401, 503])('recovers one classified refusal and settles the retry with %s', async (status) => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const auth = { ready: vi.fn().mockResolvedValue(undefined), check: vi.fn().mockResolvedValue(undefined), requireRefresh: vi.fn() }
    const upload = createWebFileUploadTransport(() => BASE, auth)
    const pending = upload(request(), {})
    const result = pending.then(value => ({ value }), (error: unknown) => ({ error }))
    await Promise.resolve()
    const first = FakeXhr.instances[0]!
    first.status = 401
    first.getResponseHeader.mockReturnValue('required')
    first.onload!()
    await vi.waitFor(() => { expect(FakeXhr.instances).toHaveLength(2) })
    const second = FakeXhr.instances[1]!
    second.status = status
    second.getResponseHeader.mockReturnValue('required')
    second.responseText = JSON.stringify({ attachmentId: `sha256:${'a'.repeat(64)}`, bytes: 8 })
    second.onload!()
    if (status === 200) expect(await result).toMatchObject({ value: { bytes: 8 } })
    else expect(await result).toMatchObject({ error: { status } })
    expect(auth.check).toHaveBeenCalledOnce()
    expect(auth.requireRefresh).toHaveBeenCalledTimes(status === 401 ? 1 : 0)
    expect(FakeXhr.send.mock.calls[0]?.[0]).toBe(FakeXhr.send.mock.calls[1]?.[0])
  })

  it.each([401, 503])('does not replay unclassified failure %s', async (status) => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const auth = { ready: async () => {}, check: vi.fn(), requireRefresh: vi.fn() }
    const pending = createWebFileUploadTransport(() => BASE, auth)(request())
    const result = expect(pending).rejects.toMatchObject({ status })
    await Promise.resolve()
    const xhr = FakeXhr.instances[0]!
    xhr.status = status
    xhr.onload!()
    await result
    expect(auth.check).not.toHaveBeenCalled()
    expect(FakeXhr.instances).toHaveLength(1)
  })

  it('does not replay an exception from the browser upload primitive', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    FakeXhr.send.mockImplementation(() => { throw new TypeError('send failed') })
    const auth = { ready: async () => {}, check: vi.fn(), requireRefresh: vi.fn() }
    await expect(createWebFileUploadTransport(() => BASE, auth)(request())).rejects.toThrow('send failed')
    expect(auth.check).not.toHaveBeenCalled()
  })

  it('does not replay a successful authenticated upload', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const auth = { ready: async () => {}, check: vi.fn(), requireRefresh: vi.fn() }
    const pending = createWebFileUploadTransport(() => BASE, auth)(request())
    await Promise.resolve()
    const xhr = FakeXhr.instances[0]!
    xhr.status = 200
    xhr.responseText = JSON.stringify({ attachmentId: `sha256:${'a'.repeat(64)}`, bytes: 8 })
    xhr.onload!()
    expect(await pending).toMatchObject({ bytes: 8 })
    expect(FakeXhr.instances).toHaveLength(1)
    expect(auth.check).not.toHaveBeenCalled()
  })

  it('reports a primitive exception during the one allowed retry without requesting reauthentication', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    FakeXhr.send.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new TypeError('retry failed') })
    const auth = { ready: async () => {}, check: async () => {}, requireRefresh: vi.fn() }
    const pending = createWebFileUploadTransport(() => BASE, auth)(request())
    const result = expect(pending).rejects.toThrow('retry failed')
    await Promise.resolve()
    const xhr = FakeXhr.instances[0]!
    xhr.status = 401
    xhr.getResponseHeader.mockReturnValue('required')
    xhr.onload!()
    await result
    expect(auth.requireRefresh).not.toHaveBeenCalled()
  })

  it('posts raw bytes with the encoded name and bare MIME headers', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const pending = transport()(request(), hooks())
    const xhr = FakeXhr.instances[0]
    if (xhr === undefined) throw new Error('xhr missing')
    expect(FakeXhr.open).toHaveBeenCalledWith('POST', `${BASE}/api/attachment/upload`)
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('content-type', 'text/plain')
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('x-attachment-name', encodeURIComponent('笔记.txt'))
    xhr.status = 200
    xhr.responseText = JSON.stringify({
      attachmentId: `sha256:${'a'.repeat(64)}`,
      bytes: 8,
      name: '笔记.txt',
      mediaType: 'text/plain',
    })
    xhr.onload?.()
    await expect(pending).resolves.toEqual({
      attachmentId: `sha256:${'a'.repeat(64)}`,
      bytes: 8,
      name: '笔记.txt',
      mediaType: 'text/plain',
    })
  })

  it('forwards upload progress and omits absent headers', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const onProgress = vi.fn()
    const pending = transport()({ data: new Blob([new Uint8Array(8)]) }, hooks({ onProgress }))
    const xhr = FakeXhr.instances[0]
    if (xhr === undefined) throw new Error('xhr missing')
    expect(xhr.setRequestHeader).not.toHaveBeenCalled()
    xhr.upload.onprogress?.({ loaded: 4, total: 8 })
    expect(onProgress).toHaveBeenCalledWith({ loaded: 4, total: 8 })
    xhr.status = 200
    xhr.responseText = JSON.stringify({ attachmentId: `sha256:${'b'.repeat(64)}`, bytes: 8 })
    xhr.onload?.()
    await expect(pending).resolves.toMatchObject({ bytes: 8 })
  })

  it('maps the route JSON error body onto code and message', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const pending = transport()(request())
    const xhr = FakeXhr.instances[0]
    if (xhr === undefined) throw new Error('xhr missing')
    xhr.status = 413
    xhr.responseText = JSON.stringify({ code: 'FILE_TOO_LARGE', message: 'too big' })
    xhr.onload?.()
    await expect(pending).rejects.toSatisfy((error: unknown) => {
      const upload = error as FileUploadError
      return upload instanceof FileUploadError && upload.status === 413
        && upload.code === 'FILE_TOO_LARGE' && upload.message === 'too big'
    })
  })

  it('falls back to a status line for non-JSON rejections', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const pending = transport()(request())
    const xhr = FakeXhr.instances[0]
    if (xhr === undefined) throw new Error('xhr missing')
    xhr.status = 403
    xhr.responseText = 'forbidden'
    xhr.onload?.()
    await expect(pending).rejects.toSatisfy((error: unknown) => {
      const upload = error as FileUploadError
      return upload instanceof FileUploadError && upload.status === 403
        && upload.code === undefined && upload.message === 'connection.upload: HTTP 403'
    })
  })

  it('rejects malformed receipts and network failures', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const malformed = transport()(request())
    const first = FakeXhr.instances[0]
    if (first === undefined) throw new Error('xhr missing')
    first.status = 200
    first.responseText = '{not json'
    first.onload?.()
    await expect(malformed).rejects.toThrow('connection.upload: malformed receipt')

    const offline = transport()(request())
    const second = FakeXhr.instances[1]
    if (second === undefined) throw new Error('second xhr missing')
    second.onerror?.()
    await expect(offline).rejects.toSatisfy((error: unknown) =>
      error instanceof FileUploadError && error.status === 0)
  })

  it('rejects a malformed attachment id in the receipt', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const pending = transport()(request())
    const xhr = FakeXhr.instances[0]
    if (xhr === undefined) throw new Error('xhr missing')
    xhr.status = 200
    xhr.responseText = JSON.stringify({ attachmentId: 'fixture:nope', bytes: 8 })
    xhr.onload?.()
    await expect(pending).rejects.toThrow('connection.upload: malformed receipt')
  })

  it('rejects a receipt whose byte count is not a number', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const pending = transport()(request())
    const xhr = FakeXhr.instances[0]
    if (xhr === undefined) throw new Error('xhr missing')
    xhr.status = 200
    xhr.responseText = JSON.stringify({ attachmentId: `sha256:${'a'.repeat(64)}`, bytes: '8' })
    xhr.onload?.()
    await expect(pending).rejects.toThrow('connection.upload: malformed receipt')
  })

  it('copies a bare Uint8Array body into its own buffer for XHR typing', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const bytes = new Uint8Array([1, 2, 3, 4])
    const pending = transport()(request({ data: bytes }))
    const xhr = FakeXhr.instances[0]
    if (xhr === undefined) throw new Error('xhr missing')
    xhr.status = 200
    xhr.responseText = JSON.stringify({ attachmentId: `sha256:${'b'.repeat(64)}`, bytes: 4 })
    xhr.onload?.()
    await expect(pending).resolves.toSatisfy((ref: unknown) =>
      ref instanceof Object && (ref as { bytes: number }).bytes === 4)
    const sent: unknown = FakeXhr.send.mock.calls[0]?.[0]
    expect(sent).toBeInstanceOf(ArrayBuffer)
    expect(sent).not.toBe(bytes.buffer)
  })

  it('bridges AbortSignal to xhr.abort and reports pre-aborted signals', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const controller = new AbortController()
    const pending = transport()(request(), hooks({ signal: controller.signal }))
    const xhr = FakeXhr.instances[0]
    if (xhr === undefined) throw new Error('xhr missing')
    controller.abort()
    expect(xhr.aborted).toBe(true)
    await expect(pending).rejects.toThrow('aborted')

    const stringReason = new AbortController()
    const reasonPending = transport()(request(), hooks({ signal: stringReason.signal }))
    const reasonXhr = FakeXhr.instances[1]
    if (reasonXhr === undefined) throw new Error('reason xhr missing')
    stringReason.abort('caller cancelled')
    await expect(reasonPending).rejects.toThrow('connection.upload: aborted')

    const preAborted = new AbortController()
    preAborted.abort()
    await expect(transport()(request(), hooks({ signal: preAborted.signal })))
      .rejects.toThrow('connection.upload: aborted')
  })
})

describe('fixture upload world', () => {
  it('mints deterministic receipts the prompt path admits with handle text and user/file', async () => {
    const world = createFixtureFaces()
    const data = new Blob([new Uint8Array(4)])
    const ref = await world.upload({ data, name: 'spec.txt' })
    expect(ref.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(ref.bytes).toBe(4)
    expect(ref.name).toBe('spec.txt')
    // Deterministic: same name+size mints the same receipt.
    const again = await world.upload({ data: new Blob([new Uint8Array(4)]), name: 'spec.txt' })
    expect(again.attachmentId).toBe(ref.attachmentId)

    const prompt = world.api.sessions.prompt?.(req({
      sessionId: 'fx-alpha' as never,
      mode: 'queue',
      content: [
        { type: 'file', attachmentId: String(ref.attachmentId), bytes: ref.bytes, ...(ref.name === undefined ? {} : { name: ref.name }) },
        { type: 'text', text: '请阅读' },
      ],
    }))
    const result = await prompt
    expect(result.result).toMatchObject({ ok: true })

    const events = await world.api.sessions.history?.(req({
      sessionId: 'fx-alpha' as never,
      beforeSeq: 10_000,
      maxMessages: 20,
    }))
    if (!events?.result.ok) throw new Error('history failed')
    const log = events.result.value.events.map(entry => entry.event)
    const fileEvent = log.find(event => event.type === 'user/file')
    expect(fileEvent).toBeDefined()
    const message = [...log].reverse().find(event => event.type === 'user/message') as {
      data: { content: { type: string; text?: string }[]; source: { files?: unknown[] } }
    }
    expect(message.data.source.files).toEqual([ref])
    const handle = message.data.content.find(block => block.type === 'text' && block.text?.startsWith('[文件] '))
    expect(handle?.text).toContain(`[文件] spec.txt · 4 B · sha256:${String(ref.attachmentId).slice(7, 15)}`)
    expect(handle?.text).toContain('只读路径: /fixture/attachments/v1/links/')
    // Position association: the file event immediately precedes its message.
    const types = log.map(event => event.type)
    expect(types.indexOf('user/file')).toBe(types.lastIndexOf('user/message') - 1)
  })

  it('rejects prompts referencing receipts the world never minted', async () => {
    const world = createFixtureFaces()
    const prompt = world.api.sessions.prompt?.(req({
      sessionId: 'fx-alpha' as never,
      mode: 'queue',
      content: [
        { type: 'file', attachmentId: `sha256:${'c'.repeat(64)}`, bytes: 3 },
        { type: 'text', text: 'x' },
      ],
    }))
    const result = await prompt
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error' },
    })
  })
})
