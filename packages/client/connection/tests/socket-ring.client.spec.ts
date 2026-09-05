import { describe, expect, it } from 'vitest'
import { SocketRing } from '../src/client/web-api-client.ts'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '../src/client/api.ts'

const sid = (id: string): SessionId => id as SessionId

function frame(n: number): { kind: 'frame'; envelope: { rpcId: ReturnType<typeof RpcId>; payload: MuxFrame } } {
  return {
    kind: 'frame',
    envelope: { rpcId: RpcId(`rpc-${n}`), payload: { type: 'session/subscribed', sessionId: sid(`s${n}`), lastSeq: 0 } },
  }
}

describe('web-api-client socket ring', () => {
  it('delivers frames in FIFO order across slot reuse', () => {
    const ring = new SocketRing<MuxFrame>()
    ring.push(frame(1))
    ring.push(frame(2))
    expect(ring.length).toBe(2)
    expect(ring.take()).toEqual(frame(1))
    ring.push(frame(3))
    ring.push(frame(4))
    expect(ring.take()).toEqual(frame(2))
    expect(ring.take()).toEqual(frame(3))
    expect(ring.take()).toEqual(frame(4))
    expect(ring.take()).toBeUndefined()
  })

  it('re-linearizes when growth lands on a wrapped tail', () => {
    const ring = new SocketRing<MuxFrame>()
    ring.push(frame(1))
    ring.push(frame(2))
    expect(ring.take()).toEqual(frame(1))
    ring.push(frame(3))
    ring.push(frame(4))
    ring.push(frame(5))
    expect(ring.length).toBe(4)
    const drained = [ring.take(), ring.take(), ring.take(), ring.take()]
    expect(drained).toEqual([frame(2), frame(3), frame(4), frame(5)])
    expect(ring.take()).toBeUndefined()
  })

  it('releases every slot once drained to empty', () => {
    const ring = new SocketRing<MuxFrame>()
    ring.push(frame(1))
    ring.push(frame(2))
    ring.push(frame(3))
    expect(ring.take()).toEqual(frame(1))
    expect(ring.take()).toEqual(frame(2))
    expect(ring.take()).toEqual(frame(3))
    expect(ring.length).toBe(0)
    ring.push(frame(4))
    expect(ring.take()).toEqual(frame(4))
    expect(ring.take()).toBeUndefined()
  })

  it('carries the end marker like any other frame', () => {
    const ring = new SocketRing<MuxFrame>()
    const end = { kind: 'end' } as const
    ring.push(end)
    expect(ring.take()).toEqual(end)
  })
})
