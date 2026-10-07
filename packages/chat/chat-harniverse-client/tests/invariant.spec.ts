/** Closed-table invariant: every announced request addresses an endpoint of its kind. */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ClientInvariant from '../src/invariant.ts'
import { bootClient, restoreInternals } from './helpers.ts'

let booted: Context | undefined

afterEach(async () => {
  restoreInternals()
  await booted?.fiber.dispose()
  booted = undefined
})

async function setup(): Promise<Awaited<ReturnType<typeof bootClient>>> {
  const result = await bootClient()
  booted = result.ctx
  await result.ctx.plugin(InvariantRegistry)
  await result.ctx.plugin(ClientInvariant)
  return result
}

describe('chat-harniverse-client invariants', () => {
  it('accepts real client traffic', async () => {
    const { client, carrier } = await setup()
    carrier.ok('POST /api/host.describe', { bootId: 'b' })
    carrier.ok('POST /api/commands/execute', undefined)
    carrier.script('POST /api/respond', { json: { accepted: true, authentication: carrier.identity } })
    carrier.script('POST /api/attachment/upload', { json: { attachmentId: 'a', bytes: 1 } })
    carrier.ok('POST /api/session.selectModelTarget', { target: { kind: 'model' }, selected: { provider: 'p', model: 'm' } })
    await client.describeHost()
    await client.call('session.selectModelTarget', { sessionId: 's', target: { kind: 'model', selection: { provider: 'p', model: 'm' } } })
    await client.typert('commands/execute', { agentId: 's', line: '/compact', images: [] })
    await client.respond('r', { ok: true, value: {} })
    await client.upload(new Uint8Array(1), {})
    expect(client.muxUrl({}, undefined).pathname).toBe('/api/events.mux')
  })

  it('admits the per-session model target and still refuses unlisted session methods', async () => {
    const { ctx } = await setup()
    expect(() => { ctx.emit('chat-harniverse/request', { kind: 'unary', target: 'session.selectModelTarget' }) }).not.toThrow()
    expect(() => { ctx.emit('chat-harniverse/request', { kind: 'unary', target: 'session.selectModelProfile' }) }).toThrow('outside the closed endpoint table')
  })

  it('rejects a request for an endpoint outside the table of its kind', async () => {
    const { ctx } = await setup()
    expect(() => { ctx.emit('chat-harniverse/request', { kind: 'unary', target: 'terminal.create' }) }).toThrow('outside the closed endpoint table')
    expect(() => { ctx.emit('chat-harniverse/request', { kind: 'typert', target: 'terminal/create' }) }).toThrow('outside the closed endpoint table')
    expect(() => { ctx.emit('chat-harniverse/request', { kind: 'respond', target: '/api/other' }) }).toThrow('outside the closed endpoint table')
    expect(() => { ctx.emit('chat-harniverse/request', { kind: 'mux', target: '/api/events.host' }) }).toThrow('outside the closed endpoint table')
  })
})
