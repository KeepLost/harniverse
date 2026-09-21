/**
 * Tests for the control-channel contract: frame codec bounds, incremental
 * decoding, send-queue and pending-call backpressure, and the lifecycle
 * state machine's terminal stability.
 */

import { describe, expect, it } from 'vitest'
import {
  assertControlTransition,
  canTransitionControlLifecycle,
  ControlFrameDecoder,
  ControlLifecycleError,
  ControlProtocolError,
  ControlSendQueue,
  encodeControlFrame,
  isTerminalControlState,
  PendingCallGate,
} from '@deepseek-ai/dsh-control-channel'
import type { ControlChannelLimits, ControlLifecycleState } from '@deepseek-ai/dsh-control-channel'

const lifecyclePairs: readonly (readonly [ControlLifecycleState, ControlLifecycleState])[] = [
  ['starting', 'running'],
  ['running', 'result-recorded'],
  ['result-recorded', 'quiescent'],
  ['quiescent', 'cleaned-up'],
]

const tightLimits: ControlChannelLimits = { maxFrameBytes: 64, maxQueuedBytes: 96, maxPendingCalls: 2, closeGraceMs: 10 }

describe('frame codec', () => {
  it('round-trips frames through the incremental decoder across split chunks', () => {
    const decoder = new ControlFrameDecoder()
    const frames = [
      { kind: 'call', id: 1, target: 'fs.read', args: ['/a'] },
      { kind: 'log', text: 'half' },
      { kind: 'reply', id: 1, ok: true, value: 7 },
      { kind: 'done', error: { kind: 'timeout', message: 'deadline' } },
    ] as const
    const encoded = Buffer.concat(frames.map(frame => encodeControlFrame(frame)))
    const split = [encoded.subarray(0, 5), encoded.subarray(5, 12), encoded.subarray(12)]
    const decoded = split.flatMap(chunk => decoder.feed(chunk))
    expect(decoded).toEqual(frames)
  })

  it('refuses frames above the byte bound instead of splitting them', () => {
    expect(() => encodeControlFrame({ kind: 'log', text: 'x'.repeat(80) }, tightLimits))
      .toThrow(ControlProtocolError)
    const decoder = new ControlFrameDecoder(tightLimits)
    expect(() => decoder.feed(encodeControlFrame({ kind: 'log', text: 'ok' }))).not.toThrow()
  })

  it('fails a peer that declares an oversized frame and rejects malformed bodies', () => {
    const decoder = new ControlFrameDecoder(tightLimits)
    const lie = Buffer.alloc(4)
    lie.writeUInt32BE(10_000, 0)
    expect(() => decoder.feed(lie)).toThrow(/above maxFrameBytes/)
    const strict = new ControlFrameDecoder()
    const garbage = Buffer.from('garbage')
    const head = Buffer.alloc(4)
    head.writeUInt32BE(garbage.byteLength, 0)
    expect(() => strict.feed(Buffer.concat([head, garbage]))).toThrow(/not valid JSON/)
    expect(() => strict.feed(Buffer.concat([head, Buffer.from('"plain"')]))).toThrow(/missing kind/)
  })
})

describe('send queue and pending-call backpressure', () => {
  it('refuses queued writes above the byte bound and releases capacity', () => {
    const queue = new ControlSendQueue(tightLimits)
    const frame = encodeControlFrame({ kind: 'log', text: 'x'.repeat(20) }, tightLimits)
    const release = queue.reserve(frame.byteLength)
    expect(queue.queuedBytes).toBe(frame.byteLength)
    expect(() => queue.reserve(frame.byteLength + 1)).toThrow(ControlProtocolError)
    release()
    expect(() => queue.reserve(frame.byteLength)).not.toThrow()
  })

  it('gates pending calls at the configured count and reuses released ids', () => {
    const gate = new PendingCallGate(tightLimits)
    gate.acquire(1)
    gate.acquire(2)
    expect(() => { gate.acquire(3) }).toThrow(ControlProtocolError)
    expect(() => { gate.acquire(1) }).toThrow(/already pending/)
    gate.release(2)
    expect(() => { gate.acquire(3) }).not.toThrow()
    expect(gate.size).toBe(2)
    // Releasing an id that never was pending is a stable no-op (late timers
    // race cleanup), never a corruption of the count.
    gate.release(99)
    expect(gate.size).toBe(2)
  })
})

describe('lifecycle state machine', () => {
  it('walks the owned path from starting to cleaned-up', () => {
    for (const transition of lifecyclePairs) {
      expect(canTransitionControlLifecycle(...transition)).toBe(true)
      expect(() => { assertControlTransition(...transition) }).not.toThrow()
    }
    for (const terminal of ['cancelled', 'timed-out', 'channel-closed'] as const) {
      expect(canTransitionControlLifecycle('running', terminal)).toBe(true)
      expect(canTransitionControlLifecycle(terminal, 'quiescent')).toBe(true)
      expect(isTerminalControlState(terminal)).toBe(true)
    }
    expect(canTransitionControlLifecycle('starting', 'cleaned-up')).toBe(true)
  })

  it('forbids crossing terminal categories and skipping cleanup', () => {
    const forbiddenPairs: readonly (readonly [ControlLifecycleState, ControlLifecycleState])[] = [
      ['result-recorded', 'cancelled'],
      ['cancelled', 'timed-out'],
      ['running', 'cleaned-up'],
      ['quiescent', 'running'],
      ['cleaned-up', 'quiescent'],
      ['starting', 'result-recorded'],
    ]
    for (const forbidden of forbiddenPairs) {
      expect(() => { assertControlTransition(...forbidden) }).toThrow(ControlLifecycleError)
      expect(canTransitionControlLifecycle(...forbidden)).toBe(false)
    }
    expect(isTerminalControlState('running')).toBe(false)
    expect(isTerminalControlState('cleaned-up')).toBe(false)
  })
})
