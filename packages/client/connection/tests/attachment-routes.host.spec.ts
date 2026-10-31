/** Streaming file-upload route: trust fence, authentication, operate capability, byte caps, receipt. */

import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef, SaveFileAttachment, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  type AuthenticationDecision,
  type AuthenticationPrincipal,
  type InboundAuthentication,
} from '@deepseek-ai/dsh-authentication'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { registerAttachmentRoutes, UPLOAD_IMAGE_PATH, UPLOAD_PATH } from '../src/attachment-routes.ts'

const OPERATE_PRINCIPAL: AuthenticationPrincipal = { kind: 'bypass', capabilities: ['harniverse.operate'] }
const OBSERVER_PRINCIPAL: AuthenticationPrincipal = { kind: 'bypass', capabilities: ['harniverse.observe'] }

const saves: SaveFileAttachment[] = []

function provideAuthentication(ctx: Context, principal: AuthenticationPrincipal): void {
  ctx.provide('authentication', {
    mode: 'authenticated',
    authenticate: () => Promise.resolve({ kind: 'accepted', principal } satisfies AuthenticationDecision),
    status: () => Promise.resolve({ mode: 'authenticated', sealed: false }),
    createBrowserSession: () => Promise.resolve({ kind: 'rejected', reason: 'invalid-credential' }),
    requestEnrollment: () => Promise.reject(new Error('not implemented')),
    enrollmentStatus: () => Promise.resolve(undefined),
    listPendingEnrollments: () => Promise.resolve([]),
    approveEnrollment: () => Promise.reject(new Error('not implemented')),
    listGrants: () => Promise.resolve([]),
    revokeGrant: () => Promise.resolve(),
    createChallenge: () => Promise.resolve({ kind: 'rejected', reason: 'invalid-grant' }),
    exchangeAccessToken: () => Promise.resolve({ kind: 'rejected', reason: 'invalid-grant' }),
    issueEmergencyAccessToken: () => Promise.resolve({ kind: 'rejected', reason: 'invalid-grant' }),
    revokeBrowserSession: () => {},
  } as unknown as InboundAuthentication)
}

const REF: FileAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  bytes: 4,
  mediaType: 'text/plain',
  name: 'a.txt',
}

function provideStore(ctx: Context, failWith?: () => never, noLimits?: boolean): void {
  ctx.provide('attachments', {
    imageLimits: {},
    ...(noLimits === true ? {} : { fileLimits: { maxFileBytes: 1024 } }),
    saveFile: (input: SaveFileAttachment) => {
      saves.push(input)
      if (failWith !== undefined) failWith()
      return Promise.resolve(REF)
    },
    readFile: () => Promise.reject(new Error('not under test')),
    publishFileHandle: () => Promise.reject(new Error('not under test')),
  })
}

function uploadRequest(
  body: string,
  headers: Record<string, string | string[] | undefined> = {},
  url: string = UPLOAD_PATH,
): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, {
    url,
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return request
}

function responseRecorder(): { res: ServerResponse; state: { status?: number; body?: string } } {
  const state: { status?: number; body?: string } = {}
  const chunks: Buffer[] = []
  // A real Writable destination: a relayed remote response streams through
  // pipe semantics that a bare method recorder cannot serve.
  const stream = new Writable({
    write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  const endStream = stream.end.bind(stream)
  Object.defineProperty(state, 'body', {
    configurable: true,
    enumerable: true,
    get(): string | undefined { return chunks.length > 0 ? Buffer.concat(chunks).toString() : undefined },
  })
  const res = Object.assign(stream, {
    writeHead(status: number): ServerResponse {
      state.status = status
      return res
    },
    end(chunk?: string | Buffer): ServerResponse {
      if (typeof chunk === 'string' || chunk instanceof Buffer) chunks.push(Buffer.from(chunk))
      endStream()
      return res
    },
  }) as unknown as ServerResponse
  return { res, state }
}

interface Mounted {
  route: WebRoute
  imageRoute: WebRoute
  dispose: () => Promise<void>
}

async function mounted(
  principal: AuthenticationPrincipal,
  failWith?: () => never,
  noLimits?: boolean,
  remoteHosts?: { request: (id: string, path: string, init?: RequestInit) => Promise<Response> },
): Promise<Mounted> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', {
    register(route: WebRoute) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    registerUpgrade: () => () => {},
    tapIndex: () => () => {},
    port: 0,
    host: '127.0.0.1',
    protocol: 'http:',
  })
  provideAuthentication(ctx, principal)
  provideStore(ctx, failWith, noLimits)
  if (remoteHosts !== undefined) ctx.provide('remoteHosts', remoteHosts as never)
  const fiber = ctx.plugin({
    name: 'attachment-routes-test',
    inject: ['webServer', 'authentication', 'attachments'],
    apply: (pluginCtx: Context) => { registerAttachmentRoutes(pluginCtx, [], []) },
  })
  await fiber.await()
  expect(routes).toHaveLength(2)
  const route = routes.find(candidate => candidate.path === UPLOAD_PATH)
  const imageRoute = routes.find(candidate => candidate.path === UPLOAD_IMAGE_PATH)
  expect(route).toBeDefined()
  expect(imageRoute).toBeDefined()
  return { route: route!, imageRoute: imageRoute!, dispose: () => fiber.dispose() }
}

describe('attachment upload route', () => {
  it('accepts an authenticated operate principal and returns the durable receipt', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL)
    const { res, state } = responseRecorder()
    await route.handler(uploadRequest('data', { 'x-attachment-name': encodeURIComponent('季度 报告.pdf') }), res)
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body!)).toEqual({
      attachmentId: REF.attachmentId,
      bytes: REF.bytes,
      mediaType: 'text/plain',
      name: 'a.txt',
    })
    expect(saves).toHaveLength(1)
    expect(saves[0]!.name).toBe('季度 报告.pdf')
    expect(saves[0]!.mediaType).toBe('text/plain')
    expect(Buffer.from(saves[0]!.data).toString()).toBe('data')
    await dispose()
  })

  it('forwards an upload to the remote host its query parameter selects', async () => {
    saves.length = 0
    const forwarded: { id: string; path: string; method?: string; headers: Headers; body?: string }[] = []
    const { route, imageRoute, dispose } = await mounted(OPERATE_PRINCIPAL, undefined, undefined, {
      request: async (id: string, path: string, init?: RequestInit) => {
        forwarded.push({
          id,
          path,
          ...(init?.method === undefined ? {} : { method: init.method }),
          headers: new Headers(init?.headers),
          ...(init?.body === undefined ? {} : { body: await new Response(init.body).text() }),
        })
        return new Response(JSON.stringify({ forwarded: true }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const { res, state } = responseRecorder()
    await route.handler(
      uploadRequest('remote-data', {
        'x-attachment-name': encodeURIComponent('remote.txt'),
        'x-multi': ['one', 'two'],
        'x-absent': undefined,
      }, `${UPLOAD_PATH}?dshRemoteHost=0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d`),
      res,
    )
    expect(state.status).toBe(201)
    expect(JSON.parse(state.body!)).toEqual({ forwarded: true })
    expect(saves).toHaveLength(0)
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toMatchObject({
      id: '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
      path: UPLOAD_PATH,
      method: 'POST',
      body: 'remote-data',
    })
    expect(forwarded[0]!.headers.get('x-attachment-name')).toBe(encodeURIComponent('remote.txt'))
    // Repeated header values survive the hop as one comma-joined entry.
    expect(forwarded[0]!.headers.get('x-multi')).toBe('one, two')
    expect(forwarded[0]!.headers.has('x-absent')).toBe(false)
    expect(forwarded[0]!.headers.has('authorization')).toBe(false)
    // The image-staging route forwards under the same parameter.
    const staged = responseRecorder()
    await imageRoute.handler(
      uploadRequest('remote-image', { 'content-type': 'image/png' },
        `${UPLOAD_IMAGE_PATH}?dshRemoteHost=0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d`),
      staged.res,
    )
    expect(staged.state.status).toBe(201)
    expect(forwarded[1]).toMatchObject({ path: UPLOAD_IMAGE_PATH, body: 'remote-image' })
    expect(saves).toHaveLength(0)
    await dispose()
  })

  it('refuses a malformed remote target instead of storing locally', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL)
    const { res, state } = responseRecorder()
    await route.handler(uploadRequest('data', {}, `${UPLOAD_PATH}?dshRemoteHost=not-a-uuid`), res)
    expect(state.status).toBe(400)
    expect(saves).toHaveLength(0)
    await dispose()
  })

  it('reports unavailable remote routing instead of storing locally', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL)
    const { res, state } = responseRecorder()
    await route.handler(uploadRequest('data', {}, `${UPLOAD_PATH}?dshRemoteHost=0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d`), res)
    expect(state.status).toBe(503)
    expect(saves).toHaveLength(0)
    await dispose()
  })

  it('reports a failed remote request and relays a body-less remote answer', async () => {
    saves.length = 0
    let failFirst = true
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL, undefined, undefined, {
      request: async () => {
        if (failFirst) {
          failFirst = false
          throw new Error('ssh transport collapsed')
        }
        return new Response(null, { status: 204 })
      },
    })
    const failure = responseRecorder()
    await route.handler(uploadRequest('data', {}, `${UPLOAD_PATH}?dshRemoteHost=0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d`), failure.res)
    expect(failure.state.status).toBe(502)
    expect(JSON.parse(failure.state.body!)).toEqual({ error: 'remote host request failed' })
    const empty = responseRecorder()
    await route.handler(uploadRequest('data', {}, `${UPLOAD_PATH}?dshRemoteHost=0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d`), empty.res)
    expect(empty.state.status).toBe(204)
    expect(empty.state.body).toBeUndefined()
    expect(saves).toHaveLength(0)
    await dispose()
  })

  it('refuses a request outside the /api trust fence with a bare 403', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL)
    const { res, state } = responseRecorder()
    await route.handler(uploadRequest('data', { host: '10.0.0.9:8080' }), res)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    expect(saves).toHaveLength(0)

    const bare = responseRecorder()
    const request = Readable.from([Buffer.from('data')]) as unknown as IncomingMessage
    Object.assign(request, {
      method: 'POST',
      headers: { host: '10.0.0.9:8080' },
      socket: {},
    })
    await route.handler(request, bare.res)
    expect(bare.state.status).toBe(403)
    await dispose()
  })

  it('accepts an upload without a name or declared media type and collapses repeated headers', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL)
    const { res, state } = responseRecorder()
    await route.handler(uploadRequest('data', { 'x-attachment-name': undefined, 'content-type': undefined }), res)
    expect(state.status).toBe(200)
    expect(saves).toHaveLength(1)
    expect(saves[0]!.name).toBeUndefined()
    expect(saves[0]!.mediaType).toBeUndefined()

    const repeated = responseRecorder()
    await route.handler(uploadRequest('data', { 'content-type': ['text/plain; charset=utf-8', 'text/html'] as unknown as string }), repeated.res)
    expect(repeated.state.status).toBe(200)
    expect(saves[1]!.mediaType).toBe('text/plain')

    const bare = responseRecorder()
    await route.handler(uploadRequest('data', { 'content-type': '; boundary=nothing' }), bare.res)
    expect(bare.state.status).toBe(200)
    expect(saves[2]!.mediaType).toBeUndefined()
    await dispose()
  })

  it('reports an interrupted request stream as a plain upload failure', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL)
    const { res, state } = responseRecorder()
    const request = new Readable({ read() {} }) as unknown as IncomingMessage
    Object.assign(request, {
      url: UPLOAD_PATH,
      method: 'POST',
      headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const pending = route.handler(request, res)
    await new Promise((resolve) => { setImmediate(resolve) })
    request.emit('error', new Error('connection reset'))
    await pending
    expect(state.status).toBe(500)
    expect(state.body).toBe('upload failed')
    expect(saves).toHaveLength(0)
    await dispose()
  })

  it('reports missing attachment storage with 501 and reads without configured file limits', async () => {
    saves.length = 0
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', {
      register(route: WebRoute) { routes.push(route); return () => {} },
      registerUpgrade: () => () => {},
      tapIndex: () => () => {},
      port: 0, host: '127.0.0.1', protocol: 'http:',
    })
    provideAuthentication(ctx, OPERATE_PRINCIPAL)
    const fiber = ctx.plugin({
      name: 'attachment-routes-nostore-test',
      inject: ['webServer', 'authentication'],
      apply: (pluginCtx: Context) => { registerAttachmentRoutes(pluginCtx, [], []) },
    })
    await fiber.await()
    const missing = responseRecorder()
    await routes[0]!.handler(uploadRequest('data'), missing.res)
    expect(missing.state.status).toBe(501)
    await fiber.dispose()

    const { route, dispose } = await mounted(OPERATE_PRINCIPAL, undefined, true)
    const unlimited = responseRecorder()
    await route.handler(uploadRequest('data', { 'content-length': '999999999999' }), unlimited.res)
    expect(unlimited.state.status).toBe(200)
    expect(saves).toHaveLength(1)
    await dispose()
  })

  it('refuses an unauthenticated upload with 401 before reading the body', async () => {    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', {
      register(route: WebRoute) { routes.push(route); return () => {} },
      registerUpgrade: () => () => {},
      tapIndex: () => () => {},
      port: 0, host: '127.0.0.1', protocol: 'http:',
    })
    ctx.provide('authentication', {
      authenticate: () => Promise.resolve({ kind: 'rejected', reason: 'missing-credential' }),
    })
    provideStore(ctx)
    const fiber = ctx.plugin({
      name: 'attachment-routes-test',
      inject: ['webServer', 'authentication', 'attachments'],
      apply: (pluginCtx: Context) => { registerAttachmentRoutes(pluginCtx, [], []) },
    })
    await fiber.await()
    const { res, state } = responseRecorder()
    const anonymous = Readable.from([Buffer.from('data')]) as unknown as IncomingMessage
    Object.assign(anonymous, {
      method: 'POST',
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    await routes[0]!.handler(anonymous, res)
    expect(state.status).toBe(401)
    await fiber.dispose()
  })

  it('refuses an observer principal with 403 even before capability checks on the store', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OBSERVER_PRINCIPAL)
    const { res, state } = responseRecorder()
    await route.handler(uploadRequest('data'), res)
    expect(state.status).toBe(403)
    expect(saves).toHaveLength(0)
    await dispose()
  })

  it('rejects an over-cap Content-Length with 413 before reading any body byte', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL)
    const { res, state } = responseRecorder()
    await route.handler(uploadRequest('data', { 'content-length': '2000' }), res)
    expect(state.status).toBe(413)
    expect(saves).toHaveLength(0)
    await dispose()
  })

  it('rejects a chunked body that crosses the cap mid-stream', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL)
    const { res, state } = responseRecorder()
    const request = Readable.from([Buffer.alloc(512, 1), Buffer.alloc(512, 1), Buffer.alloc(512, 1)]) as unknown as IncomingMessage
    Object.assign(request, {
      url: UPLOAD_PATH, method: 'POST',
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/octet-stream' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    await route.handler(request, res)
    expect(state.status).toBe(413)
    expect(saves).toHaveLength(0)
    await dispose()
  })

  it('maps store admission failures onto stable HTTP statuses', async () => {
    const { AttachmentError } = await import('@deepseek-ai/dsh-attachment')
    const tooLarge = await mounted(OPERATE_PRINCIPAL, () => {
      throw new AttachmentError('File exceeds the configured byte limit.', 'FILE_TOO_LARGE')
    })
    const large = responseRecorder()
    await tooLarge.route.handler(uploadRequest('data'), large.res)
    expect(large.state.status).toBe(413)
    await tooLarge.dispose()

    const invalid = await mounted(OPERATE_PRINCIPAL, () => {
      throw new AttachmentError('File is empty.', 'INVALID_FILE')
    })
    const empty = responseRecorder()
    await invalid.route.handler(uploadRequest(''), empty.res)
    expect(empty.state.status).toBe(400)
    await invalid.dispose()

    const unclassified = await mounted(OPERATE_PRINCIPAL, () => {
      throw new AttachmentError('Storage refused the write.', 'ATTACHMENT_WRITE_FAILED')
    })
    const failed = responseRecorder()
    await unclassified.route.handler(uploadRequest('data'), failed.res)
    expect(failed.state.status).toBe(500)
    expect(JSON.parse(failed.state.body!)).toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    await unclassified.dispose()
  })

  it('refuses an undecodable attachment-name header with 400', async () => {
    saves.length = 0
    const { route, dispose } = await mounted(OPERATE_PRINCIPAL)
    const { res, state } = responseRecorder()
    await route.handler(uploadRequest('data', { 'x-attachment-name': '%zz' }), res)
    expect(state.status).toBe(400)
    expect(saves).toHaveLength(0)
    await dispose()
  })

  it('is described by the exported upload path under the /api prefix', () => {
    expect(UPLOAD_PATH).toBe('/api/attachment/upload')
    expect(UPLOAD_IMAGE_PATH).toBe('/api/attachment/upload-image')
    expect(ALL_AUTHENTICATION_CAPABILITIES).toContain('harniverse.operate')
  })
})

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
  name: '图.png',
}

/** Mutable image-store capture the image specs reset between cases. */
const imageState = {
  validations: [] as SaveImageAttachment[],
  saves: [] as SaveImageAttachment[],
}

function imageLimits(over: Partial<ImageAttachmentLimits> = {}): ImageAttachmentLimits {
  return {
    maxImageBytes: 1024,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 512,
    maxImagePixels: 1_000_000,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    ...over,
  }
}

type ImageRefusal = (input: SaveImageAttachment) => void

/**
 * Mount the routes with a controllable image store: `validate`/`save` run in
 * route order and record every input; either may refuse with AttachmentError.
 */
async function mountedImage(options: {
  limits?: ImageAttachmentLimits
  validate?: ImageRefusal
  save?: ImageRefusal
  store?: boolean
  principal?: AuthenticationPrincipal
} = {}): Promise<{ route: WebRoute; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', {
    register(route: WebRoute) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    registerUpgrade: () => () => {},
    tapIndex: () => () => {},
    port: 0, host: '127.0.0.1', protocol: 'http:',
  })
  provideAuthentication(ctx, options.principal ?? OPERATE_PRINCIPAL)
  if (options.store !== false) {
    ctx.provide('attachments', {
      imageLimits: options.limits ?? imageLimits(),
      fileLimits: { maxFileBytes: 1024 },
      validateImage: (input: SaveImageAttachment) => {
        imageState.validations.push(input)
        options.validate?.(input)
        return Promise.resolve()
      },
      saveImage: (input: SaveImageAttachment) => {
        imageState.saves.push(input)
        options.save?.(input)
        return Promise.resolve(IMAGE_REF)
      },
    })
  }
  const fiber = ctx.plugin({
    name: 'attachment-image-routes-test',
    // Without a store the plugin must not wait on the missing service before
    // registering routes (the 501 path is the handler's own refusal).
    inject: options.store === false ? ['webServer', 'authentication'] : ['webServer', 'authentication', 'attachments'],
    apply: (pluginCtx: Context) => { registerAttachmentRoutes(pluginCtx, [], []) },
  })
  await fiber.await()
  const route = routes.find(candidate => candidate.path === UPLOAD_IMAGE_PATH)
  expect(route).toBeDefined()
  return { route: route!, dispose: () => fiber.dispose() }
}

function imageUploadRequest(
  body: string | Buffer[],
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage {
  const source = Array.isArray(body)
    ? Readable.from(body) as unknown as IncomingMessage
    : Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(source, {
    url: UPLOAD_IMAGE_PATH,
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'content-type': 'image/png', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return source
}

describe('image staging upload route', () => {
  it('validates then saves the staged image and returns the durable reference', async () => {
    imageState.validations = []
    imageState.saves = []
    const { route, dispose } = await mountedImage()
    const { res, state } = responseRecorder()
    await route.handler(imageUploadRequest('data', { 'x-attachment-name': encodeURIComponent('图.png') }), res)
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body!)).toEqual(IMAGE_REF)
    expect(imageState.validations).toHaveLength(1)
    expect(imageState.saves).toHaveLength(1)
    expect(imageState.validations[0]).toEqual(imageState.saves[0])
    expect(imageState.validations[0]!.mediaType).toBe('image/png')
    expect(imageState.validations[0]!.name).toBe('图.png')
    expect(Buffer.from(imageState.validations[0]!.data).toString()).toBe('data')
    await dispose()
  })

  it('reads at most the smaller of the per-image and per-message byte limits', async () => {
    imageState.validations = []
    imageState.saves = []
    // maxImageBytes 1024 but maxMessageImageBytes 512: the read stops at 512.
    const { route, dispose } = await mountedImage({ limits: imageLimits({ maxMessageImageBytes: 512 }) })
    const preflight = responseRecorder()
    await route.handler(imageUploadRequest('data', { 'content-length': '600' }), preflight.res)
    expect(preflight.state.status).toBe(413)
    expect(JSON.parse(preflight.state.body!)).toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    expect(imageState.validations).toHaveLength(0)

    const midStream = responseRecorder()
    await route.handler(imageUploadRequest([Buffer.alloc(384, 1), Buffer.alloc(384, 1)]), midStream.res)
    expect(midStream.state.status).toBe(413)
    expect(imageState.saves).toHaveLength(0)

    // Raising the per-message budget moves the bound back to the per-image cap.
    const wider = await mountedImage({ limits: imageLimits({ maxMessageImageBytes: 2048 }) })
    const accepted = responseRecorder()
    await wider.route.handler(imageUploadRequest('data', { 'content-length': '600' }), accepted.res)
    expect(accepted.state.status).toBe(200)
    expect(imageState.saves).toHaveLength(1)
    await wider.dispose()
    await dispose()
  })

  it('refuses media types outside the deployment list, including a missing declaration', async () => {
    imageState.validations = []
    const { route, dispose } = await mountedImage()
    const unsupported = responseRecorder()
    await route.handler(imageUploadRequest('data', { 'content-type': 'image/bmp' }), unsupported.res)
    expect(unsupported.state.status).toBe(400)
    expect(JSON.parse(unsupported.state.body!)).toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE' })

    const undeclared = responseRecorder()
    await route.handler(imageUploadRequest('data', { 'content-type': undefined }), undeclared.res)
    expect(undeclared.state.status).toBe(400)
    expect(JSON.parse(undeclared.state.body!)).toMatchObject({ code: 'UNSUPPORTED_IMAGE_TYPE' })
    expect(imageState.validations).toHaveLength(0)
    await dispose()
  })

  it('maps admission refusals onto stable HTTP statuses with the error code body', async () => {
    imageState.saves = []
    const invalid = await mountedImage({
      validate: () => { throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE') },
    })
    const undecodable = responseRecorder()
    await invalid.route.handler(imageUploadRequest('data'), undecodable.res)
    expect(undecodable.state.status).toBe(400)
    expect(JSON.parse(undecodable.state.body!)).toEqual({ code: 'INVALID_IMAGE', message: 'Unsupported or malformed image data.' })
    expect(imageState.saves).toHaveLength(0)
    await invalid.dispose()

    const pixels = await mountedImage({
      validate: () => { throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS') },
    })
    const huge = responseRecorder()
    await pixels.route.handler(imageUploadRequest('data'), huge.res)
    expect(huge.state.status).toBe(400)
    expect(JSON.parse(huge.state.body!)).toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
    await pixels.dispose()

    const oversized = await mountedImage({
      validate: () => { throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE') },
    })
    const tooLarge = responseRecorder()
    await oversized.route.handler(imageUploadRequest('data'), tooLarge.res)
    expect(tooLarge.state.status).toBe(413)
    expect(JSON.parse(tooLarge.state.body!)).toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    await oversized.dispose()

    const unclassified = await mountedImage({
      save: () => { throw new AttachmentError('Storage refused the write.', 'ATTACHMENT_WRITE_FAILED') },
    })
    const failed = responseRecorder()
    await unclassified.route.handler(imageUploadRequest('data'), failed.res)
    expect(failed.state.status).toBe(500)
    expect(JSON.parse(failed.state.body!)).toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    await unclassified.dispose()
  })

  it('reports an interrupted request stream without saving anything', async () => {
    imageState.saves = []
    const { route, dispose } = await mountedImage()
    const { res, state } = responseRecorder()
    const request = new Readable({ read() {} }) as unknown as IncomingMessage
    Object.assign(request, {
      url: UPLOAD_IMAGE_PATH,
      method: 'POST',
      headers: { host: '127.0.0.1:3080', 'content-type': 'image/png' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const pending = route.handler(request, res)
    await new Promise((resolve) => { setImmediate(resolve) })
    request.emit('error', new Error('connection reset'))
    await pending
    expect(state.status).toBe(500)
    expect(state.body).toBe('upload failed')
    expect(imageState.saves).toHaveLength(0)
    await dispose()
  })

  it('keeps the trust fence, the operate capability, and the store requirement', async () => {
    imageState.validations = []
    const { route, dispose } = await mountedImage()
    const untrusted = responseRecorder()
    await route.handler(imageUploadRequest('data', { host: '10.0.0.9:8080' }), untrusted.res)
    expect(untrusted.state.status).toBe(403)
    expect(untrusted.state.body).toBe('forbidden')
    expect(imageState.validations).toHaveLength(0)
    await dispose()

    const observer = await mountedImage({ principal: OBSERVER_PRINCIPAL })
    const observed = responseRecorder()
    await observer.route.handler(imageUploadRequest('data'), observed.res)
    expect(observed.state.status).toBe(403)
    expect(imageState.validations).toHaveLength(0)
    await observer.dispose()

    const noStore = await mountedImage({ store: false })
    const missing = responseRecorder()
    await noStore.route.handler(imageUploadRequest('data'), missing.res)
    expect(missing.state.status).toBe(501)
    await noStore.dispose()
  })
})
