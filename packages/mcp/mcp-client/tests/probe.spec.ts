/**
 * Probe contract tests: one-shot connect / identity / tools-list / close
 * against an in-memory SDK peer, with stage classification, budget caps, and
 * independent cleanup settlement.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { probeServer } from '../src/probe.ts'
import type { Config } from '../src/config.ts'

const { transportFactory } = vi.hoisted(() => ({ transportFactory: vi.fn() }))
vi.mock('../src/transport.ts', () => ({ createTransport: transportFactory }))

const PROBE_CONFIG: Config = {
  transport: 'stdio', serverName: 'peer', command: 'unused', args: [], env: {}, cwd: '',
  toolCallTimeoutMs: 1_000, failOnStartupError: false,
}

let peer: InMemoryTransport | undefined

afterEach(async () => {
  // One spec injects a failing transport close; the teardown must not surface it.
  await peer?.close().catch(() => {})
})

/** One scripted peer answering initialize and tools/list over in-memory transport. */
function mountPeer(respond: (method: string, id: unknown) => Record<string, unknown> | undefined) {
  const [transport, server] = InMemoryTransport.createLinkedPair()
  peer = server
  transportFactory.mockReturnValue(transport)
  server.onmessage = (message) => {
    if (!('method' in message) || !('id' in message)) return
    const result = respond(message.method, message.id)
    if (result !== undefined) void server.send({ jsonrpc: '2.0', id: message.id, result })
  }
  return server.start()
}

function toolsResult(names: string[], nextCursor?: string) {
  return {
    tools: names.map(name => ({ name, description: '', inputSchema: { type: 'object' } })),
    ...nextCursor === undefined ? {} : { nextCursor },
  }
}

describe('probeServer', () => {
  it('connects, reads the identity, lists tool names, and closes cleanly', async () => {
    await mountPeer(method => method === 'initialize'
      ? { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { tools: {} }, serverInfo: { name: 'peer', version: '9.9.9' } }
      : method === 'tools/list' ? toolsResult(['add', 'greet'])
        : undefined)
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 2_000 })
    expect(result).toMatchObject({
      ok: true,
      serverInfo: { name: 'peer', version: '9.9.9' },
      toolNames: ['add', 'greet'],
      truncated: false,
      cleanup: 'ok',
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('follows listing cursors up to the page cap and reports truncation', async () => {
    let page = 0
    await mountPeer(method => method === 'initialize'
      ? { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { tools: {} }, serverInfo: { name: 'peer', version: '1' } }
      : method === 'tools/list'
        ? (page += 1) === 1
          ? toolsResult(['first'], 'page-2')
          : toolsResult([`page-${page}`], `page-${page + 1}`)
        : undefined)
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 2_000, maxPages: 3 })
    expect(result).toMatchObject({ ok: true, truncated: true, toolNames: ['first', 'page-2', 'page-3'] })
  })

  it('caps retained tool names without paging further', async () => {
    await mountPeer(method => method === 'initialize'
      ? { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { tools: {} }, serverInfo: { name: 'peer', version: '1' } }
      : method === 'tools/list' ? toolsResult(['a', 'b', 'c'], 'more')
        : undefined)
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 2_000, maxToolNames: 2 })
    expect(result).toMatchObject({ ok: true, truncated: true, toolNames: ['a', 'b'] })
  })

  it('classifies a connect failure at the connect stage without throwing', async () => {
    const [transport, server] = InMemoryTransport.createLinkedPair()
    peer = server
    transportFactory.mockReturnValue(transport)
    await server.close()
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 2_000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.stage).toBe('connect')
    expect(result.cleanup).toBe('ok')
  })

  it('classifies a tools/list rejection at the list stage', async () => {
    await mountPeer(method => method === 'initialize'
      ? { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { tools: {} }, serverInfo: { name: 'peer', version: '1' } }
      : method === 'tools/list'
        ? (() => { throw new Error('listing exploded') })()
        : undefined)
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 2_000 })
    expect(result).toMatchObject({ ok: false, stage: 'list' })
  })

  it('settles as an aborted failure when the signal fires', async () => {
    await mountPeer(method => method === 'initialize'
      ? { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { tools: {} }, serverInfo: { name: 'peer', version: '1' } }
      : method === 'tools/list' ? toolsResult(['add'])
        : undefined)
    const controller = new AbortController()
    const pending = probeServer(PROBE_CONFIG, { timeoutMs: 5_000, signal: controller.signal })
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ ok: false, message: 'probe aborted' })
  })

  it('rejects invalid option values', async () => {
    await expect(probeServer(PROBE_CONFIG, { timeoutMs: 0 })).rejects.toThrow(TypeError)
    await expect(probeServer(PROBE_CONFIG, { maxPages: 0 })).rejects.toThrow(TypeError)
    await expect(probeServer(PROBE_CONFIG, { maxToolNames: 1.5 })).rejects.toThrow(TypeError)
  })

  it('classifies a whole-probe budget timeout at the connect stage', async () => {
    const [transport, server] = InMemoryTransport.createLinkedPair()
    peer = server
    transportFactory.mockReturnValue(transport)
    // The peer never answers initialize, so the connect budget runs out first.
    await server.start()
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 80 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.stage).toBe('connect')
      expect(result.message).toMatch(/connect timed out after \d+ms/u)
    }
  })

  it('classifies a whole-probe budget timeout at the list stage', async () => {
    await mountPeer(method => method === 'initialize'
      ? { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { tools: {} }, serverInfo: { name: 'peer', version: '1' } }
      : undefined)
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 150 })
    expect(result).toMatchObject({ ok: false, stage: 'list' })
    if (!result.ok) expect(result.message).toMatch(/list timed out after \d+ms/u)
  })

  it('skips listing for a tools-less peer while reading its identity', async () => {
    await mountPeer(method => method === 'initialize'
      ? { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { resources: {} }, serverInfo: { name: 'peer', version: '1' } }
      : undefined)
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 2_000 })
    expect(result).toMatchObject({
      ok: true,
      serverInfo: { name: 'peer', version: '1' },
      toolNames: [],
      truncated: false,
      cleanup: 'ok',
    })
  })

  it('settles as an aborted failure when the signal is already aborted', async () => {
    await mountPeer(method => method === 'initialize'
      ? { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { tools: {} }, serverInfo: { name: 'peer', version: '1' } }
      : method === 'tools/list' ? toolsResult(['add'])
        : undefined)
    const controller = new AbortController()
    controller.abort()
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 2_000, signal: controller.signal })
    expect(result).toMatchObject({ ok: false, message: 'probe aborted' })
  })

  it('names the error kind when the wire rejects with an empty message', async () => {
    await mountPeer(method => method === 'initialize'
      ? { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { tools: {} }, serverInfo: { name: 'peer', version: '1' } }
      : undefined)
    peer!.onmessage = (message) => {
      if (!('method' in message) || !('id' in message)) return
      if (message.method === 'initialize') {
        void peer!.send({
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: { tools: {} }, serverInfo: { name: 'peer', version: '1' } },
        })
        return
      }
      if (message.method === 'tools/list') {
        void peer!.send({ jsonrpc: '2.0', id: message.id, error: { code: -32_000, message: '' } })
      }
    }
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 2_000 })
    expect(result).toMatchObject({ ok: false, stage: 'list' })
  })

  it('classifies a failed closure independently of the stage outcome', async () => {
    const [transport, server] = InMemoryTransport.createLinkedPair()
    peer = server
    Object.assign(transport, {
      close: () => Promise.reject(new Error('close bug')),
    })
    transportFactory.mockReturnValue(transport)
    await server.start()
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 2_000 })
    expect(result).toMatchObject({ ok: false, stage: 'connect', cleanup: 'failed', cleanupError: 'close bug' })
  })

  it('ignores late settlements after the budget timer fired', async () => {
    const [transport, server] = InMemoryTransport.createLinkedPair()
    peer = server
    transportFactory.mockReturnValue(transport)
    // initialize resolves (and one probe errors) only after the tiny budget
    // already rejected, so both late arms hit the settled guard.
    server.onmessage = (message) => {
      if (!('method' in message) || !('id' in message)) return
      const answer = message.method === 'initialize'
        ? { jsonrpc: '2.0' as const, id: message.id, result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.at(-1)!, capabilities: {}, serverInfo: { name: 'peer', version: '1' } } }
        : { jsonrpc: '2.0' as const, id: message.id, error: { code: -32_000, message: 'late' } }
      setTimeout(() => { void server.send(answer) }, 150)
    }
    await server.start()
    const result = await probeServer(PROBE_CONFIG, { timeoutMs: 60 })
    expect(result).toMatchObject({ ok: false, stage: 'connect' })
    await new Promise(resolve => setTimeout(resolve, 200))
  })
})
