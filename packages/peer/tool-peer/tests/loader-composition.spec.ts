/** The peer tool booted through the real Loader: composition wiring, model-visible output, and disposal. */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolPeer from '@deepseek-ai/dsh-tool-peer'
import { CallId } from '@deepseek-ai/dsh-llm'
import { peerInstanceId } from '@deepseek-ai/dsh-peer-protocol'
import type { PeerTarget } from '@deepseek-ai/dsh-peer-protocol'
import { writePeerTargets } from '@deepseek-ai/dsh-peer-client'

let root: string | undefined
let context: Context | undefined
let targetServer: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await new Promise<void>((resolve) => { targetServer?.close(() => { resolve() }) })
  targetServer = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot one cordis.yml wiring the tool row with the given config lines. */
async function boot(configLines: readonly string[]): Promise<Context> {
  const configPath = join(root as string, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-peer'",
    '  config:',
    ...configLines,
  ].join('\n'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root as string).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-peer', ToolPeer],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const row of ctx.loader.entries()) {
    if (!row.disabled && row.fiber !== undefined && row.fiber.state === FiberState.FAILED) await row.fiber.await()
  }
  return ctx
}

it('executes a delegated turn through the booted composition and unloads with its row', async () => {
  root = await mkdtemp(join(tmpdir(), 'peer-tool-loader-'))
  targetServer = createServer((req, response) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => { chunks.push(chunk as Buffer) })
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { rpcId?: string }
      const send = (value: unknown): void => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }))
      }
      if (req.url === '/auth/challenge') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ id: 'cha', payload: 'c2lnbg', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
        return
      }
      if (req.url === '/auth/token') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
        return
      }
      send({ sessionId: 'peer-loader-1', messageId: 'm', state: 'settled', reply: 'loader reply', endReason: 'completed' })
    })
  })
  const origin = await new Promise<string>((resolve) => {
    targetServer?.listen(0, '127.0.0.1', () => {
      const address = targetServer?.address()
      if (address !== null && address !== undefined && typeof address !== 'string') resolve(`http://127.0.0.1:${String(address.port)}`)
    })
  })
  const target: PeerTarget = {
    targetInstanceId: peerInstanceId('3f2a8f9e-1111-4222-8333-444455556666'),
    displayName: 'Build workstation',
    endpoint: { origin },
    transport: { kind: 'direct' },
    grantName: 'peer-3f2a8f9e-1111-4222-8333-444455556666',
    grantId: 'grant-1',
    status: 'active',
    addedAt: '2026-01-01T00:00:00.000Z',
  }
  await writePeerTargets(root, [target])
  context = await boot([
    `    dshHome: ${JSON.stringify(root)}`,
    '    defaultTimeoutMs: 5000',
  ])
  expect(context.tools.get('peer')).toBeDefined()
  const result = await context.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('call-loader'),
    name: 'peer',
    arguments: { target: 'Build workstation', prompt: 'loader prompt' },
  })
  expect(result.isError).toBeFalsy()
  const text2 = result.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
  expect(text2).toContain('Delegated session peer-loader-1 on Build workstation replied:')
  expect(text2).toContain('loader reply')
})
