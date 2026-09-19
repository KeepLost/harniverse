/**
 * Tests for the image-offload contract: setting parsing, per-image user-turn
 * aging, pressure settlement, and the compaction/already-offloaded stop rules.
 */

import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  OFFLOADED_IMAGE_STUB_TEXT,
  parseImageOffloadSetting,
  resolveImageOffloadDecisions,
} from '@deepseek-ai/dsh-image-offload-policy'

function images(count: number): ContentBlock[] {
  return Array.from({ length: count }, () => ({ type: 'image', attachment: {} }) as ContentBlock)
}

function userMessage(seq: number, imageCount = 0): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: { id: `m${seq}`, role: 'user', content: images(imageCount), source: { kind: 'direct' } },
    surfaceOp: 'append',
    sourceEventSeqs: [seq],
  } as unknown as SessionEvent
}

function toolResult(seq: number, imageCount: number): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `t${seq}`,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', content: images(imageCount) }],
        source: { kind: 'tool', callId: 'c1' },
      },
    },
    surfaceOp: 'append',
    sourceEventSeqs: [seq],
  } as unknown as SessionEvent
}

function assistantMessage(seq: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: { turn: 1, step: 1, message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { model: 'x' } } },
    surfaceOp: 'append',
    sourceEventSeqs: [seq],
  } as unknown as SessionEvent
}

function offload(seq: number, targets: readonly { messageSeq: number; imageIndex: number }[]): SessionEvent {
  return { type: 'image/offload', seq, time: 0, data: { targets } } as unknown as SessionEvent
}

function compactionReplace(seq: number, shadowed: number[]): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: { turn: 1, step: 1, message: { id: `s${seq}`, role: 'assistant', content: [{ type: 'text', text: 'summary' }], source: { model: 'x' } } },
    surfaceOp: { op: 'replace', start: 0, end: 0 },
    sourceEventSeqs: shadowed,
  } as unknown as SessionEvent
}

describe('parseImageOffloadSetting', () => {
  it('accepts unlimited and positive integers only', () => {
    expect(parseImageOffloadSetting('unlimited')).toBe('unlimited')
    expect(parseImageOffloadSetting(1)).toBe(1)
    expect(parseImageOffloadSetting(4)).toBe(4)
    for (const bad of [0, -1, 1.5, 'four', null, undefined, true]) {
      expect(() => parseImageOffloadSetting(bad)).toThrow(TypeError)
    }
  })
})

describe('resolveImageOffloadDecisions', () => {
  it('offloads an image on the configured later user turn, not before', () => {
    const events = [userMessage(1, 1), assistantMessage(2), userMessage(3), assistantMessage(4), userMessage(5)]
    expect(resolveImageOffloadDecisions(events, { setting: 4 })).toEqual([])
    const thirdTurn = [...events, userMessage(7)]
    expect(resolveImageOffloadDecisions(thirdTurn, { setting: 4 })).toEqual([])
    const fourthTurn = [...thirdTurn, userMessage(8)]
    expect(resolveImageOffloadDecisions(fourthTurn, { setting: 4 })).toEqual([
      { target: { messageSeq: 1, imageIndex: 0 }, reason: 'age' },
    ])
  })

  it('counts only user messages: assistant, tool traffic, and multiple assistant turns do not age an image', () => {
    const events = [userMessage(1, 1), assistantMessage(2), toolResult(3, 0), assistantMessage(4), assistantMessage(5)]
    expect(resolveImageOffloadDecisions(events, { setting: 1 })).toEqual([])
    expect(resolveImageOffloadDecisions([...events, userMessage(6)], { setting: 1 })).toEqual([
      { target: { messageSeq: 1, imageIndex: 0 }, reason: 'age' },
    ])
  })

  it('ages each image occurrence independently by its carrying event', () => {
    const events = [userMessage(1, 1), userMessage(2, 2), userMessage(3), userMessage(4)]
    expect(resolveImageOffloadDecisions(events, { setting: 3 })).toEqual([
      { target: { messageSeq: 1, imageIndex: 0 }, reason: 'age' },
    ])
    expect(resolveImageOffloadDecisions([...events, userMessage(5)], { setting: 3 })).toEqual([
      { target: { messageSeq: 1, imageIndex: 0 }, reason: 'age' },
      { target: { messageSeq: 2, imageIndex: 0 }, reason: 'age' },
      { target: { messageSeq: 2, imageIndex: 1 }, reason: 'age' },
    ])
    expect(resolveImageOffloadDecisions(events, { setting: 4 })).toEqual([])
  })

  it('tracks tool-result re-reads as fresh occurrences', () => {
    const events = [userMessage(1, 1), userMessage(2), toolResult(3, 1), userMessage(4)]
    expect(resolveImageOffloadDecisions(events, { setting: 2 })).toEqual([
      { target: { messageSeq: 1, imageIndex: 0 }, reason: 'age' },
    ])
    expect(resolveImageOffloadDecisions([...events, userMessage(5)], { setting: 2 })).toEqual([
      { target: { messageSeq: 1, imageIndex: 0 }, reason: 'age' },
      { target: { messageSeq: 3, imageIndex: 0 }, reason: 'age' },
    ])
  })

  it('never re-settles an image a prior offload recorded', () => {
    const events = [userMessage(1, 1), userMessage(2), offload(3, [{ messageSeq: 1, imageIndex: 0 }]), userMessage(4), userMessage(5)]
    expect(resolveImageOffloadDecisions(events, { setting: 1 })).toEqual([])
  })

  it('stops counting images shadowed by a compaction replacement', () => {
    const events = [userMessage(1, 1), userMessage(2), compactionReplace(3, [1, 2]), userMessage(4), userMessage(5)]
    expect(resolveImageOffloadDecisions(events, { setting: 1 })).toEqual([])
    expect(resolveImageOffloadDecisions(events, { setting: 1, pressureCount: 1 })).toEqual([])
  })

  it('takes the oldest active images for pressure and combines with age decisions', () => {
    const events = [userMessage(1, 1), userMessage(2, 1), userMessage(3)]
    expect(resolveImageOffloadDecisions(events, { setting: 'unlimited', pressureCount: 1 })).toEqual([
      { target: { messageSeq: 1, imageIndex: 0 }, reason: 'pressure' },
    ])
    const aged = [userMessage(1, 1), userMessage(2, 1), userMessage(3), userMessage(4)]
    expect(resolveImageOffloadDecisions(aged, { setting: 3, pressureCount: 1 })).toEqual([
      { target: { messageSeq: 1, imageIndex: 0 }, reason: 'age' },
      { target: { messageSeq: 2, imageIndex: 0 }, reason: 'pressure' },
    ])
  })

  it('returns nothing under unlimited without pressure', () => {
    const events = [userMessage(1, 1), userMessage(2), userMessage(3), userMessage(4)]
    expect(resolveImageOffloadDecisions(events, { setting: 'unlimited' })).toEqual([])
    expect(OFFLOADED_IMAGE_STUB_TEXT).toContain('retained')
  })
})
