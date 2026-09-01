import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { NotificationEnvelope } from '@deepseek-ai/dsh-notification'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as NotificationHttp from '../src/index.ts'

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(configPath: string): Promise<{ ctx: Context; include: Include }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root as string).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-notification-http', NotificationHttp],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  const includeEntry = [...ctx.loader.entries()].find(entry => entry.subtree !== undefined)
  if (includeEntry?.subtree === undefined) throw new Error('expected Loader include subtree')
  return { ctx, include: includeEntry.subtree as Include }
}

function yaml(url?: string | null): string {
  const lines = [
    '- id: sessions',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: storage',
    "  name: '@deepseek-ai/dsh-storage'",
    '- id: storage-json',
    "  name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root as string, 'storage'))}`,
    '- id: storage-domain',
    "  name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
  ]
  if (url !== undefined) {
    lines.push(
      '- id: notification-http',
      "  name: '@deepseek-ai/dsh-notification-http'",
      '  config:',
      '    shutdownTimeoutMs: 1000',
    )
    if (url === null) lines.push('    endpoints: []')
    else lines.push(
      '    endpoints:',
      '      - id: receiver',
      `        url: ${JSON.stringify(url)}`,
      '        retry:',
      '          maxAttempts: 1',
      '        subscriptions:',
      '          - event: approval.requested',
      '          - event: tool.called',
      '          - event: tool.settled',
      '          - event: session.turn-settled',
      '          - event: session.closed',
    )
  }
  return `${lines.join('\n')}\n`
}

async function requestBody(request: IncomingMessage): Promise<NotificationEnvelope> {
  request.setEncoding('utf8')
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return JSON.parse(body) as NotificationEnvelope
}

describe('notification-http through a real Loader composition', () => {
  it('preserves source order and withdraws then restores delivery across config refresh', async () => {
    const received: NotificationEnvelope[] = []
    const server = createServer((request, response) => {
      void requestBody(request).then((body) => {
        received.push(body)
        response.writeHead(204).end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const url = `http://127.0.0.1:${address.port}/events`

    try {
      root = await mkdtemp(join(tmpdir(), 'dsh-notification-http-loader-'))
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, yaml(url))
      const { ctx, include } = await loadComposition(configPath)
      expect(ctx.get('notification')).toBeInstanceOf(NotificationHttp.HttpNotificationBackend)

      const session = ctx.sessions.create(SessionId('loader-notification'))
      const callId = CallId('call-1')
      session.append('turn/start', { turn: 1 })
      session.append('approval/asked', {
        id: ApprovalRequestId('approval-1'),
        toolName: 'bash',
        callId,
      })
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"private":true}' })
      session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'private result' }], isError: false }),
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      ctx.sessions.emitClosed({ sessionId: session.id })

      await vi.waitFor(() => { expect(received).toHaveLength(5) }, { timeout: 10_000 })
      expect(received.map(event => event.type)).toEqual([
        'approval.requested',
        'tool.called',
        'tool.settled',
        'session.turn-settled',
        'session.closed',
      ])
      expect(JSON.stringify(received)).not.toContain('private')

      await writeFile(configPath, yaml())
      await include.refresh()
      await ctx.loader.await()
      expect(ctx.get('notification')).toBeUndefined()
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(received).toHaveLength(5)

      await writeFile(configPath, yaml(url))
      await include.refresh()
      await ctx.loader.await()
      expect(ctx.get('notification')).toBeInstanceOf(NotificationHttp.HttpNotificationBackend)
      session.append('turn/start', { turn: 3 })
      session.append('approval/asked', { id: ApprovalRequestId('approval-2'), toolName: 'write' })
      await vi.waitFor(() => { expect(received).toHaveLength(6) }, { timeout: 10_000 })
      expect(received[5]).toMatchObject({ type: 'approval.requested', data: { approvalId: 'approval-2' } })
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('performs zero requests when Loader mounts the provider without endpoints', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-notification-http-empty-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, yaml(null))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      const { ctx } = await loadComposition(configPath)
      const session = ctx.sessions.create(SessionId('loader-silent'))
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
