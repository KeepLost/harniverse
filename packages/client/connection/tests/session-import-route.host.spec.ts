import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { AuthenticationDecision, AuthenticationPrincipal, InboundAuthentication } from '@deepseek-ai/dsh-authentication'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import { registerSessionImportRoute } from '../src/session-import-route.ts'

const operator: AuthenticationPrincipal = { kind: 'bypass', capabilities: ['harniverse.operate'] }
const observer: AuthenticationPrincipal = { kind: 'bypass', capabilities: ['harniverse.observe'] }

function auth(ctx: Context, principal: AuthenticationPrincipal): void {
  ctx.provide('authentication', {
    mode: 'authenticated',
    authenticate: () => Promise.resolve({ kind: 'accepted', principal } satisfies AuthenticationDecision),
  } as unknown as InboundAuthentication)
}

function request(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(req, {
    method: 'POST', url: '/api/session/import',
    headers: { host: '127.0.0.1:3080', 'content-length': String(Buffer.byteLength(body)), ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return req
}

function response(): { value: ServerResponse; state: { status?: number; body?: string } } {
  const state: { status?: number; body?: string } = {}
  return {
    value: {
      writeHead: (status: number) => { state.status = status },
      end: (body?: string) => { state.body = body },
    } as unknown as ServerResponse,
    state,
  }
}

async function mounted(principal: AuthenticationPrincipal): Promise<{
  route: WebRoute
  importer: ReturnType<typeof vi.fn>
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', { register: (route: WebRoute) => { routes.push(route); return () => {} } } as never)
  auth(ctx, principal)
  const importer = vi.fn(() => Promise.resolve({
    sessionId: 'session-imported' as never, artifactName: 'source.jsonl', format: 'official-v3', mappedEvents: 1, skippedEvents: 1,
  }))
  ctx.provide('sessionImport', { import: importer } as never)
  const workspace = { id: WorkspaceId('workspace-1'), path: '/authorized/project', attachSession: vi.fn() }
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === workspace.id ? workspace : undefined,
  } as never)
  const fiber = ctx.plugin({
    inject: ['webServer', 'authentication'],
    apply: (inner: Context) => registerSessionImportRoute(inner, [], [], 1024),
  })
  await fiber.await()
  return { route: routes[0]!, importer, dispose: () => fiber.dispose() }
}

describe('authenticated session import route', () => {
  it('passes uploaded bytes, destination workspace, and selected posture to the importer', async () => {
    const mountedRoute = await mounted(operator)
    try {
      const result = response()
      await mountedRoute.route.handler(request('foreign bytes', {
        'x-session-workspace': 'workspace-1', 'x-session-supervision': 'unsupervised',
      }), result.value)
      expect(result.state.status).toBe(201)
      expect(mountedRoute.importer).toHaveBeenCalledWith({
        artifact: expect.any(Buffer), cwd: '/authorized/project', posture: { supervisionMode: 'unsupervised' },
      })
      expect(JSON.parse(result.state.body!)).toMatchObject({ attached: true, workspaceId: 'workspace-1' })
    } finally { await mountedRoute.dispose() }
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
