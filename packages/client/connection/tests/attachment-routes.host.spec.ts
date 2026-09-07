/** Streaming file-upload route: trust fence, authentication, operate capability, byte caps, receipt. */

import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FileAttachmentRef, SaveFileAttachment } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  ALL_AUTHENTICATION_CAPABILITIES,
  type AuthenticationDecision,
  type AuthenticationPrincipal,
  type InboundAuthentication,
} from '@deepseek-ai/dsh-authentication'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { registerAttachmentRoutes, UPLOAD_PATH } from '../src/attachment-routes.ts'

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
): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, {
    url: UPLOAD_PATH,
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return request
}

function responseRecorder(): { res: ServerResponse; state: { status?: number; body?: string } } {
  const state: { status?: number; body?: string } = {}
  const chunks: Buffer[] = []
  const res = Object.assign(Object.create(null), {
    writeHead(status: number) { state.status = status; return this },
    write(chunk: string | Buffer) { chunks.push(Buffer.from(chunk)); return true },
    end(chunk?: string | Buffer) {
      if (typeof chunk === 'string' || chunk instanceof Buffer) chunks.push(Buffer.from(chunk))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      return this
    },
  }) as unknown as ServerResponse
  return { res, state }
}

interface Mounted {
  route: WebRoute
  dispose: () => Promise<void>
}

async function mounted(principal: AuthenticationPrincipal, failWith?: () => never, noLimits?: boolean): Promise<Mounted> {
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
  const fiber = ctx.plugin({
    name: 'attachment-routes-test',
    inject: ['webServer', 'authentication', 'attachments'],
    apply: (pluginCtx: Context) => { registerAttachmentRoutes(pluginCtx, [], []) },
  })
  await fiber.await()
  expect(routes).toHaveLength(1)
  return { route: routes[0]!, dispose: () => fiber.dispose() }
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
    expect(ALL_AUTHENTICATION_CAPABILITIES).toContain('harniverse.operate')
  })
})
