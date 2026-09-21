import { Readable } from 'node:stream'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { AuthenticationDecision, AuthenticationPrincipal, InboundAuthentication } from '@deepseek-ai/dsh-authentication'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ForeignLogError } from '@deepseek-ai/dsh-session-import'
import { describe, expect, it, vi } from 'vitest'
import { registerSessionImportRoute } from '../src/session-import-route.ts'

const operator: AuthenticationPrincipal = { kind: 'bypass', capabilities: ['harniverse.operate'] }
const observer: AuthenticationPrincipal = { kind: 'bypass', capabilities: ['harniverse.observe'] }

function auth(ctx: Context, principal: AuthenticationPrincipal) {
  const authenticate = vi.fn<InboundAuthentication['authenticate']>()
    .mockResolvedValue({ kind: 'accepted', principal } satisfies AuthenticationDecision)
  ctx.provide('authentication', {
    mode: 'authenticated',
    authenticate,
  } as unknown as InboundAuthentication)
  return authenticate
}

function request(body: string | Iterable<Uint8Array> | AsyncIterable<Uint8Array>, headers: IncomingHttpHeaders = {}): IncomingMessage {
  const req = Readable.from(typeof body === 'string' ? [Buffer.from(body)] : body) as unknown as IncomingMessage
  Object.assign(req, {
    method: 'POST', url: '/api/session/import',
    headers: {
      host: '127.0.0.1:3080',
      ...typeof body === 'string' ? { 'content-length': String(Buffer.byteLength(body)) } : {},
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return req
}

function response(): { value: ServerResponse; state: { status?: number; body?: string } } {
  const state: { status?: number; body?: string } = {}
  return {
    value: {
      writeHead: (status: number) => { state.status = status },
      end: (body?: string) => { if (body !== undefined) state.body = body },
    } as unknown as ServerResponse,
    state,
  }
}

async function mounted(principal: AuthenticationPrincipal, unavailable?: 'sessionImport' | 'workspaceRegistry') {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', { register: (route: WebRoute) => { routes.push(route); return () => {} } } as never)
  const authenticate = auth(ctx, principal)
  const importer = vi.fn(() => Promise.resolve({
    sessionId: 'session-imported' as never, artifactName: 'source.jsonl', format: 'official-v3', mappedEvents: 1, skippedEvents: 1,
  }))
  if (unavailable !== 'sessionImport') ctx.provide('sessionImport', { import: importer } as never)
  const workspace = {
    id: WorkspaceId('workspace-1'), path: '/authorized/project',
    attachSession: vi.fn<(_id: string) => Promise<void>>().mockResolvedValue(undefined),
  }
  const getWorkspace = vi.fn((id: WorkspaceId) => id === workspace.id ? workspace : undefined)
  if (unavailable !== 'workspaceRegistry') ctx.provide('workspaceRegistry', { get: getWorkspace } as never)
  const fiber = ctx.plugin({
    inject: ['webServer', 'authentication'],
    apply: (inner: Context) => { registerSessionImportRoute(inner, [], [], 1024) },
  })
  await fiber.await()
  return { route: routes[0]!, importer, authenticate, workspace, getWorkspace, dispose: () => fiber.dispose() }
}

describe('authenticated session import route', () => {
  it.each([
    { name: 'untrusted host', headers: { host: 'attacker.example:3080' } },
    { name: 'untrusted origin', headers: { origin: 'https://attacker.example' } },
  ])('rejects $name before authentication or reading the upload', async ({ headers }) => {
    const mountedRoute = await mounted(operator)
    const req = request('foreign bytes', { 'x-session-workspace': 'workspace-1', ...headers })
    const read = vi.spyOn(req, Symbol.asyncIterator)
    try {
      const result = response()
      await mountedRoute.route.handler(req, result.value)
      expect(result.state).toEqual({ status: 403, body: JSON.stringify({ error: 'forbidden' }) })
      expect(mountedRoute.authenticate).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      expect(mountedRoute.importer).not.toHaveBeenCalled()
      expect(mountedRoute.workspace.attachSession).not.toHaveBeenCalled()
    } finally { read.mockRestore(); req.destroy(); await mountedRoute.dispose() }
  })

  it.each([
    { decision: { kind: 'rejected', reason: 'missing-credential' }, status: 401, body: 'unauthorized' },
    { decision: { kind: 'rejected', reason: 'rate-limited', retryAfterMs: 2500 }, status: 429, body: 'rate limited' },
  ] satisfies { decision: AuthenticationDecision; status: number; body: string }[])(
    'preserves the authentication rejection response ($status)', async ({ decision, status, body }) => {
      const mountedRoute = await mounted(operator)
      mountedRoute.authenticate.mockResolvedValue(decision)
      const req = request('foreign bytes', { 'x-session-workspace': 'workspace-1' })
      const read = vi.spyOn(req, Symbol.asyncIterator)
      try {
        const result = response()
        await mountedRoute.route.handler(req, result.value)
        expect(result.state).toEqual({ status, body })
        expect(mountedRoute.authenticate).toHaveBeenCalledExactlyOnceWith({ channel: 'http-api', peerAddress: '127.0.0.1' })
        expect(read).not.toHaveBeenCalled()
        expect(mountedRoute.importer).not.toHaveBeenCalled()
        expect(mountedRoute.workspace.attachSession).not.toHaveBeenCalled()
      } finally { read.mockRestore(); req.destroy(); await mountedRoute.dispose() }
    },
  )

  it.each(['sessionImport', 'workspaceRegistry'] as const)('returns 501 when %s is unavailable', async (unavailable) => {
    const mountedRoute = await mounted(operator, unavailable)
    const req = request('foreign bytes', { 'x-session-workspace': 'workspace-1' })
    const read = vi.spyOn(req, Symbol.asyncIterator)
    try {
      const result = response()
      await mountedRoute.route.handler(req, result.value)
      expect(result.state).toEqual({ status: 501, body: JSON.stringify({ error: 'session import unavailable' }) })
      expect(read).not.toHaveBeenCalled()
      expect(mountedRoute.importer).not.toHaveBeenCalled()
      expect(mountedRoute.workspace.attachSession).not.toHaveBeenCalled()
    } finally { read.mockRestore(); req.destroy(); await mountedRoute.dispose() }
  })

  it.each([
    { name: 'GET method', method: 'GET', headers: {}, status: 405, error: 'POST required' },
    { name: 'missing workspace', method: 'POST', headers: { 'x-session-workspace': undefined }, status: 400 },
    { name: 'repeated workspace', method: 'POST', headers: { 'x-session-workspace': ['workspace-1', 'workspace-2'] }, status: 400 },
    { name: 'invalid supervision', method: 'POST', headers: { 'x-session-supervision': 'automatic' }, status: 400 },
    { name: 'repeated supervision', method: 'POST', headers: { 'x-session-supervision': ['supervised'] }, status: 400 },
    { name: 'unknown workspace', method: 'POST', headers: { 'x-session-workspace': 'workspace-unknown' }, status: 404, error: 'workspace not found' },
  ] satisfies { name: string; method: string; headers: IncomingHttpHeaders; status: number; error?: string }[])(
    'rejects $name without consuming or importing the upload', async ({ method, headers, status, error }) => {
      const mountedRoute = await mounted(operator)
      const req = request('foreign bytes', { 'x-session-workspace': 'workspace-1', ...headers })
      req.method = method
      const read = vi.spyOn(req, Symbol.asyncIterator)
      try {
        const result = response()
        await mountedRoute.route.handler(req, result.value)
        expect(result.state).toEqual({
          status, body: JSON.stringify({ error: error ?? 'x-session-workspace and a valid x-session-supervision are required' }),
        })
        expect(read).not.toHaveBeenCalled()
        expect(mountedRoute.importer).not.toHaveBeenCalled()
        expect(mountedRoute.workspace.attachSession).not.toHaveBeenCalled()
      } finally { read.mockRestore(); req.destroy(); await mountedRoute.dispose() }
    },
  )

  it('rejects an oversized Content-Length before reading the upload', async () => {
    const mountedRoute = await mounted(operator)
    const req = request('foreign bytes', { 'x-session-workspace': 'workspace-1', 'content-length': '1025' })
    const read = vi.spyOn(req, Symbol.asyncIterator)
    try {
      const result = response()
      await mountedRoute.route.handler(req, result.value)
      expect(result.state).toEqual({ status: 413, body: JSON.stringify({ error: 'source exceeds import byte limit' }) })
      expect(read).not.toHaveBeenCalled()
      expect(mountedRoute.importer).not.toHaveBeenCalled()
      expect(mountedRoute.workspace.attachSession).not.toHaveBeenCalled()
    } finally { read.mockRestore(); req.destroy(); await mountedRoute.dispose() }
  })

  it.each([
    { name: 'single chunk without Content-Length', length: undefined, chunks: [Buffer.alloc(1025)] },
    { name: 'cumulative chunks without Content-Length', length: undefined, chunks: [Buffer.alloc(1024), Buffer.from('x')] },
    { name: 'understated Content-Length', length: '1', chunks: [Buffer.alloc(1024), Buffer.from('x')] },
    { name: 'multibyte overflow', length: undefined, chunks: [Buffer.alloc(1023), Buffer.from('\u00e9')] },
  ])('enforces the streamed byte limit for $name', async ({ length, chunks }) => {
    const mountedRoute = await mounted(operator)
    const req = request(chunks, { 'x-session-workspace': 'workspace-1', 'content-length': length })
    try {
      const result = response()
      await mountedRoute.route.handler(req, result.value)
      expect(result.state).toEqual({ status: 413, body: JSON.stringify({ error: 'source exceeds import byte limit' }) })
      expect(mountedRoute.importer).not.toHaveBeenCalled()
      expect(mountedRoute.workspace.attachSession).not.toHaveBeenCalled()
    } finally { req.destroy(); await mountedRoute.dispose() }
  })

  it.each([
    { name: 'default', supervision: undefined, length: undefined },
    { name: 'explicit', supervision: 'supervised', length: '1024' },
  ])('imports the exact byte limit with $name supervision and a Uint8Array chunk', async ({ supervision, length }) => {
    const mountedRoute = await mounted(operator)
    const prefix = Buffer.alloc(1022, 'a')
    const suffix = new Uint8Array([0, 0xc3, 0xa9, 0]).subarray(1, 3)
    const req = request([prefix, suffix], {
      'x-session-workspace': 'workspace-1', 'x-session-supervision': supervision, 'content-length': length,
    })
    try {
      const result = response()
      await mountedRoute.route.handler(req, result.value)
      expect(result.state.status).toBe(201)
      expect(mountedRoute.importer).toHaveBeenCalledExactlyOnceWith({
        artifact: Buffer.from(`${'a'.repeat(1022)}\u00e9`),
        cwd: '/authorized/project', posture: { supervisionMode: 'supervised' },
      })
      expect(mountedRoute.workspace.attachSession).toHaveBeenCalledExactlyOnceWith('session-imported')
      expect(JSON.parse(result.state.body!)).toEqual({
        sessionId: 'session-imported', artifactName: 'source.jsonl', format: 'official-v3',
        mappedEvents: 1, skippedEvents: 1, attached: true, workspaceId: 'workspace-1',
      })
    } finally { req.destroy(); await mountedRoute.dispose() }
  })

  it.each(['replaced', 'removed'] as const)('refuses a workspace %s during upload', async (change) => {
    const mountedRoute = await mounted(operator)
    const replacement = {
      ...mountedRoute.workspace, path: '/replacement/project',
      attachSession: vi.fn<(_id: string) => Promise<void>>().mockResolvedValue(undefined),
    }
    async function* upload() {
      yield Buffer.from('first chunk')
      mountedRoute.getWorkspace.mockReturnValue(change === 'removed' ? undefined : replacement)
      yield Buffer.from('last chunk')
    }
    const req = request(upload(), { 'x-session-workspace': 'workspace-1' })
    try {
      const result = response()
      await mountedRoute.route.handler(req, result.value)
      expect(result.state).toEqual({ status: 409, body: JSON.stringify({ error: 'workspace changed during upload' }) })
      expect(mountedRoute.getWorkspace).toHaveBeenCalledTimes(2)
      expect(mountedRoute.importer).not.toHaveBeenCalled()
      expect(mountedRoute.workspace.attachSession).not.toHaveBeenCalled()
      expect(replacement.attachSession).not.toHaveBeenCalled()
    } finally { req.destroy(); await mountedRoute.dispose() }
  })

  it('passes uploaded bytes, destination workspace, and selected posture to the importer', async () => {
    const mountedRoute = await mounted(operator)
    try {
      const result = response()
      await mountedRoute.route.handler(request('foreign bytes', {
        'x-session-workspace': 'workspace-1', 'x-session-supervision': 'unsupervised',
      }), result.value)
      expect(result.state.status).toBe(201)
      expect(mountedRoute.importer).toHaveBeenCalledWith({
        artifact: Buffer.from('foreign bytes'), cwd: '/authorized/project', posture: { supervisionMode: 'unsupervised' },
      })
      expect(JSON.parse(result.state.body!)).toMatchObject({ attached: true, workspaceId: 'workspace-1' })
    } finally { await mountedRoute.dispose() }
  })

  it('returns the committed session with 201 when workspace attachment fails', async () => {
    const mountedRoute = await mounted(operator)
    mountedRoute.workspace.attachSession.mockRejectedValue(new Error('workspace storage unavailable'))
    try {
      const result = response()
      await mountedRoute.route.handler(request('foreign bytes', { 'x-session-workspace': 'workspace-1' }), result.value)
      expect(result.state.status).toBe(201)
      expect(JSON.parse(result.state.body!)).toEqual({
        sessionId: 'session-imported', artifactName: 'source.jsonl', format: 'official-v3',
        mappedEvents: 1, skippedEvents: 1, workspaceId: 'workspace-1', attached: false,
      })
      expect(mountedRoute.importer).toHaveBeenCalledExactlyOnceWith({
        artifact: Buffer.from('foreign bytes'), cwd: '/authorized/project', posture: { supervisionMode: 'supervised' },
      })
      expect(mountedRoute.workspace.attachSession).toHaveBeenCalledExactlyOnceWith('session-imported')
    } finally { await mountedRoute.dispose() }
  })

  it.each([
    { name: 'foreign log error', failure: new ForeignLogError('invalid foreign session header'), status: 400, error: 'invalid foreign session header' },
    { name: 'type error', failure: new TypeError('invalid import posture'), status: 400, error: 'invalid import posture' },
    { name: 'unexpected error', failure: new Error('persistence failed'), status: 500, error: 'persistence failed' },
    { name: 'non-Error rejection', failure: { detail: 'private provider failure' }, status: 500, error: 'import failed' },
  ])('maps $name to $status without attaching a session', async ({ failure, status, error }) => {
    const mountedRoute = await mounted(operator)
    mountedRoute.importer.mockRejectedValue(failure)
    try {
      const result = response()
      await mountedRoute.route.handler(request('foreign bytes', { 'x-session-workspace': 'workspace-1' }), result.value)
      expect(result.state).toEqual({ status, body: JSON.stringify({ error }) })
      expect(mountedRoute.importer).toHaveBeenCalledExactlyOnceWith({
        artifact: Buffer.from('foreign bytes'), cwd: '/authorized/project', posture: { supervisionMode: 'supervised' },
      })
      expect(mountedRoute.workspace.attachSession).not.toHaveBeenCalled()
    } finally { await mountedRoute.dispose() }
  })

  it('reports a failed upload without importing its partial bytes', async () => {
    const mountedRoute = await mounted(operator)
    async function* upload() {
      yield Buffer.from('partial upload')
      throw new Error('upload disconnected')
    }
    const req = request(upload(), { 'x-session-workspace': 'workspace-1' })
    try {
      const result = response()
      await mountedRoute.route.handler(req, result.value)
      expect(result.state).toEqual({ status: 500, body: JSON.stringify({ error: 'upload disconnected' }) })
      expect(mountedRoute.importer).not.toHaveBeenCalled()
      expect(mountedRoute.workspace.attachSession).not.toHaveBeenCalled()
    } finally { req.destroy(); await mountedRoute.dispose() }
  })

  it.each([
    { principal: observer, status: 403 },
    { principal: operator, status: 400 },
  ])('refuses product requests before importing when admission is invalid', async ({ principal, status }) => {
    const mountedRoute = await mounted(principal)
    try {
      const result = response()
      await mountedRoute.route.handler(request('foreign bytes', status === 400 ? {} : { 'x-session-workspace': 'workspace-1' }), result.value)
      expect(result.state.status).toBe(status)
      expect(mountedRoute.importer).not.toHaveBeenCalled()
    } finally { await mountedRoute.dispose() }
  })
})
