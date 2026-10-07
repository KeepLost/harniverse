/** Bridge lifecycle edge cases that the Cordis plugin shell cannot reach: duplicate attach, attach after stop, and detaching a stranger. */

import { afterEach, describe, expect, it } from 'vitest'
import { FakeChatAdapter } from '@deepseek-ai/dsh-chat-adapter-fake'
import { Bridge } from '../src/bridge.ts'
import { Config } from '../src/members.ts'
import type { BridgeState } from '../src/state.ts'
import { FakeClient } from './fixtures/fake-client.ts'

const adapters: FakeChatAdapter[] = []

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.stop().catch(() => undefined)))
})

/** A table backed by a Map, enough for the lifecycle paths under test. */
function memoryTable(): Record<string, unknown> {
  const map = new Map<string, unknown>()
  return {
    get: (key: string) => map.get(key),
    put: (key: string, value: unknown) => { map.set(key, value); return Promise.resolve() },
    delete: (key: string) => Promise.resolve(map.delete(key)),
    entries: () => map.entries(),
    get size() { return map.size },
  }
}

function direct(adapter: FakeChatAdapter): { bridge: Bridge; client: FakeClient } {
  const client = new FakeClient()
  const tables = new Map<string, Record<string, unknown>>()
  const state = { table: (name: string) => tables.get(name) ?? tables.set(name, memoryTable()).get(name) } as unknown as BridgeState
  const bridge = new Bridge({
    config: Config({}), state, client: client.asClient(),
    adapters: { list: () => [adapter], get: () => adapter },
    log: { info: () => undefined, warn: () => undefined },
    sleep: () => Promise.resolve(),
  })
  adapters.push(adapter)
  return { bridge, client }
}

describe('Bridge without the plugin shell', () => {
  it('runs an adapter once however often it is attached, and ignores a stranger on detach', async () => {
    const adapter = new FakeChatAdapter()
    const { bridge } = direct(adapter)
    bridge.start()
    bridge.attach(adapter)
    bridge.attach(adapter)
    bridge.detach(new FakeChatAdapter({ botId: 'stranger' }))
    expect(adapter.running).toBe(true)
    bridge.detach(adapter)
    bridge.detach(adapter)
    await bridge.stop()
  })

  it('refuses to attach once stopped and stops a stubborn adapter', async () => {
    const adapter = new FakeChatAdapter()
    adapter.stop = () => Promise.reject(new Error('stop failed'))
    const { bridge } = direct(adapter)
    bridge.start()
    await bridge.stop()
    bridge.attach(new FakeChatAdapter({ botId: 'late' }))
    expect(adapters).toHaveLength(1)
  })
})
