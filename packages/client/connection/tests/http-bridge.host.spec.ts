import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { bridge } from '../src/http-bridge.ts'

/** Drive one buffered `/api` reply through the bridge, capturing what the socket received. */
async function relay(
  responseBody: unknown,
  acceptEncoding: string,
  contentType = 'application/json',
): Promise<{ headers: Record<string, string>; body: Buffer }> {
  const request = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage
  Object.assign(request, {
    url: '/api/session.history',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': acceptEncoding },
  })
  const written: Buffer[] = []
  let headers: Record<string, string> = {}
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(_code: number, values?: Record<string, string>) { headers = values ?? {}; return this },
    write(chunk: Buffer) { written.push(Buffer.from(chunk)); return true },
    end(this: { writableEnded: boolean }, chunk?: Buffer) {
      if (chunk !== undefined) written.push(Buffer.from(chunk))
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  await bridge(request, response, {
    fetch: () => Promise.resolve(new Response(JSON.stringify(responseBody), { headers: { 'content-type': contentType } })),
  })
  return { headers, body: Buffer.concat(written) }
}

/** A reply large enough to clear the bridge's minimum-size floor. */
function largeReply(): { rows: string[] } {
  return { rows: Array.from({ length: 400 }, (_, index) => `history row ${index} with repeated filler text`) }
}

describe('HTTP bridge abort', () => {
  it('destroys a declared-oversize request instead of draining it', async () => {
    const destroyed: true[] = []
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.prompt',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
      destroy: () => { destroyed.push(true) },
    })
    let status: number | undefined
    let headers: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    }, 1000)
    // The socket must not stay parked draining a body the client can trickle
    // at will after the rejection — same discipline as the chunked overrun.
    expect(status).toBe(413)
    expect(headers).toMatchObject({ connection: 'close' })
    expect(destroyed).toHaveLength(1)
  })

  it('aborts a pending native picker request when the browser disconnects', async () => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'picker-1', method: 'host.pickDirectory', payload: {},
    })
    const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/host.pickDirectory',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write() { return true },
      end() { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    let carrierSignal: AbortSignal | undefined
    const pending = bridge(request, response, {
      fetch: async (input) => {
        const fetchRequest = input
        carrierSignal = fetchRequest.signal
        resolveStarted()
        if (!fetchRequest.signal.aborted) {
          await new Promise<void>((resolve) => {
            fetchRequest.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        return Response.json({ aborted: fetchRequest.signal.aborted })
      },
    }, Number.MAX_SAFE_INTEGER)
    await started
    response.emit('close')
    await pending
    expect(carrierSignal?.aborted).toBe(true)
  })
})

describe('HTTP bridge response encoding', () => {
  it('compresses a large unary reply with the encoding the client offered', async () => {
    const payload = largeReply()
    const plainBytes = Buffer.byteLength(JSON.stringify(payload))

    const brotli = await relay(payload, 'br, gzip')
    expect(brotli.headers['content-encoding']).toBe('br')
    expect(brotli.headers.vary).toBe('accept-encoding')
    // content-length must describe the encoded body, or the client stalls
    // waiting for bytes that never arrive.
    expect(Number(brotli.headers['content-length'])).toBe(brotli.body.byteLength)
    expect(brotli.body.byteLength).toBeLessThan(plainBytes / 2)
    expect(JSON.parse(brotliDecompressSync(brotli.body).toString('utf8'))).toEqual(payload)

    const gzip = await relay(payload, 'gzip, deflate')
    expect(gzip.headers['content-encoding']).toBe('gzip')
    expect(gzip.body.byteLength).toBeLessThan(plainBytes / 2)
    expect(JSON.parse(gunzipSync(gzip.body).toString('utf8'))).toEqual(payload)
  })

  it('sends a verbatim body when no offered encoding is implemented', async () => {
    const payload = largeReply()
    const identity = await relay(payload, 'identity')
    expect(identity.headers['content-encoding']).toBeUndefined()
    // The reply still varies on the header, so a shared cache cannot hand this
    // verbatim entry to a client that would have received an encoded one.
    expect(identity.headers.vary).toBe('accept-encoding')
    expect(JSON.parse(identity.body.toString('utf8'))).toEqual(payload)

    const none = await relay(payload, '')
    expect(none.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(none.body.toString('utf8'))).toEqual(payload)
  })

  it('leaves a small reply uncompressed', async () => {
    const small = await relay({ ok: true }, 'br, gzip')
    expect(small.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(small.body.toString('utf8'))).toEqual({ ok: true })
  })

  it('refuses an encoding the client rejected with q=0', async () => {
    const payload = largeReply()
    // `br;q=0` is the standard way to say "not Brotli"; honouring the token
    // while ignoring its quality would send a body the client refused.
    const noBrotli = await relay(payload, 'br;q=0, gzip')
    expect(noBrotli.headers['content-encoding']).toBe('gzip')

    const noneAtAll = await relay(payload, 'gzip;q=0, br;q=0')
    expect(noneAtAll.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(noneAtAll.body.toString('utf8'))).toEqual(payload)

    // A non-zero quality still offers the encoding.
    const weighted = await relay(payload, 'br;q=0.1')
    expect(weighted.headers['content-encoding']).toBe('br')
  })

  it('preserves an upstream vary instead of replacing it', async () => {
    const request = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.history',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'br' },
    })
    let headers: Record<string, string> = {}
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(_code: number, values?: Record<string, string>) { headers = values ?? {}; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse
    await bridge(request, response, {
      fetch: () => Promise.resolve(new Response(JSON.stringify(largeReply()), {
        headers: { 'content-type': 'application/json', vary: 'cookie' },
      })),
    })
    // Losing an upstream vary: cookie while adding our own is a
    // cache-poisoning shape, so both dimensions must survive.
    expect(headers.vary).toBe('cookie, accept-encoding')
  })

  it('streams a non-JSON body through unencoded and unbuffered', async () => {
    // The session-log ZIP export streams under a bounded capacity gate so the
    // Host never holds a whole archive; buffering it here would defeat that
    // and re-compress already-DEFLATEd entries. Only complete JSON replies may
    // be buffered, so any streaming content type is safe by construction.
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.export',
      method: 'GET',
      headers: { 'accept-encoding': 'br, gzip' },
    })
    const written: number[] = []
    let headers: Record<string, string> = {}
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(_code: number, values?: Record<string, string>) { headers = values ?? {}; return this },
      write(chunk: Buffer) { written.push(chunk.byteLength); return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let releaseSecond!: () => void
    const secondQueued = new Promise<void>((resolve) => { releaseSecond = resolve })
    const archive = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024))
        await secondQueued
        controller.enqueue(new Uint8Array(8))
        controller.close()
      },
    })
    const pending = bridge(request, response, {
      fetch: () => Promise.resolve(new Response(archive, { headers: { 'content-type': 'application/zip' } })),
    })
    // The first archive chunk must reach the socket before the producer
    // finishes, which is exactly what buffering would prevent.
    await vi.waitFor(() => { expect(written.length).toBe(1) })
    releaseSecond()
    await pending
    expect(headers['content-encoding']).toBeUndefined()
    expect(headers['content-length']).toBeUndefined()
    expect(written).toEqual([64 * 1024, 8])
  })

  it('streams an event body through unencoded and unbuffered', async () => {
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/events.mux',
      method: 'GET',
      headers: { 'accept-encoding': 'br, gzip' },
    })
    const written: string[] = []
    let headers: Record<string, string> = {}
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(_code: number, values?: Record<string, string>) { headers = values ?? {}; return this },
      write(chunk: Buffer) { written.push(Buffer.from(chunk).toString('utf8')); return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let emitSecond!: () => void
    const secondQueued = new Promise<void>((resolve) => { emitSecond = resolve })
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${'first '.repeat(400)}\n\n`))
        await secondQueued
        controller.enqueue(new TextEncoder().encode('data: second\n\n'))
        controller.close()
      },
    })
    const pending = bridge(request, response, {
      fetch: () => Promise.resolve(new Response(stream, { headers: { 'content-type': 'text/event-stream' } })),
    })
    // The first frame must reach the socket before the stream ends; an encoder
    // or a buffer here would hold every frame until close.
    await vi.waitFor(() => { expect(written.length).toBe(1) })
    emitSecond()
    await pending
    expect(headers['content-encoding']).toBeUndefined()
    expect(headers['content-length']).toBeUndefined()
    expect(written).toHaveLength(2)
    expect(written[1]).toBe('data: second\n\n')
  })
})
