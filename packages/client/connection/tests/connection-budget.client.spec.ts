/**
 * Connection budget ledger: WebSocket and SSE counts track every long-lived
 * per-origin connection, and crossing the browser's HTTP/1.1 pool line warns
 * exactly once — the loud regression signal for any new per-entity fan-out.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectionBudgetSnapshot, noteSseClose, noteSseOpen, noteWebSocketClose, noteWebSocketOpen,
} from '../src/client/connection-budget.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('connection budget', () => {
  it('tracks websocket and SSE counts independently', () => {
    const before = connectionBudgetSnapshot()
    noteWebSocketOpen()
    noteSseOpen()
    expect(connectionBudgetSnapshot()).toEqual({ websockets: before.websockets + 1, serverSentEvents: before.serverSentEvents + 1 })
    noteWebSocketClose()
    noteSseClose()
    expect(connectionBudgetSnapshot()).toEqual(before)
  })

  it('never counts below zero when closes race their opens', () => {
    noteWebSocketClose()
    noteSseClose()
    const snapshot = connectionBudgetSnapshot()
    expect(snapshot.websockets).toBeGreaterThanOrEqual(0)
    expect(snapshot.serverSentEvents).toBeGreaterThanOrEqual(0)
  })

  it('warns exactly once when the pool line is crossed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = connectionBudgetSnapshot()
    const open: Array<() => void> = []
    for (let index = 0; index < 7 - (before.websockets + before.serverSentEvents); index += 1) {
      open.push(noteSseOpen)
    }
    for (const note of open) note()
    if (open.length > 0) expect(warn).toHaveBeenCalledTimes(1)
    noteSseOpen()
    noteWebSocketOpen()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('per-origin')
    for (let index = 0; index < open.length + 2; index += 1) noteSseClose()
    noteWebSocketClose()
  })
})
