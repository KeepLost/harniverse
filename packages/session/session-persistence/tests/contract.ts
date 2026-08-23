/**
 * Reusable contract test for any {@link SessionPersistence} backend. A backend
 * package imports {@link runPersistenceContract} and calls it with a factory
 * that yields a fresh, empty backend (and a teardown), so every backend is held
 * to the same append-only / contiguous-seq / lazy-materialization / crash
 * semantics. The JSONL backend's own spec adds file-specific tests on top.
 *
 * @module @deepseek-ai/dsh-session-persistence/tests/contract
 */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SurfaceEventType, SurfaceIntent } from '@deepseek-ai/dsh-session'
import { CallId, MessageId, createMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { CHECKPOINT_SEARCH_MESSAGE_BUDGET } from '../src/index.ts'
import type { SessionPersistence } from '../src/index.ts'

/** A backend under test plus its teardown. */
export interface ContractBackend {
  persistence: SessionPersistence
  dispose: () => Promise<void>
}

/** Build a minimal {@link SessionHeader} for a session id. */
export function meta(id: string, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1000,
    ...cwd !== undefined ? { cwd } : {},
  }
}

/** A well-formed one-turn event log (contiguous seqs from 0). */
export function oneTurnLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: freezeMessage({
      id: MessageId('one-turn-user'),
      role: 'user',
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time: 4, data: {
      turn: 1, step: 1,
      message: freezeMessage({
        id: MessageId('one-turn-assistant'),
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * Append recorded events to a live session while forwarding surface metadata verbatim. The broad
 * `SessionEvent` union makes the typed marker optional, but the runtime guard must still reject a
 * surface event whose fixture omitted it; this helper never synthesizes a default.
 */
export function appendLog(session: Session, events: readonly SessionEvent[]): void {
  for (const e of events) {
    const se = e as SessionEvent<SurfaceEventType>
    if (se.surfaceOp !== undefined) {
      const intent: SurfaceIntent = {
        surfaceOp: se.surfaceOp,
        ...se.sourceEventSeqs !== undefined ? { sourceEventSeqs: se.sourceEventSeqs } : {},
      }
      session.append(e.type, e.data, intent)
    } else {
      session.append(e.type, e.data)
    }
  }
}

/**
 * Run the backend-agnostic contract suite. `make()` MUST return a fresh, empty
 * backend each call.
 */
export function runPersistenceContract(name: string, make: () => Promise<ContractBackend>): void {
  describe(`SessionPersistence contract: ${name}`, () => {
    it('round-trips a session: create + append → load returns identical meta and byte-identical events', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s1', '/work')
        const log = oneTurnLog()
        await persistence.create(m)
        await persistence.append(m.id, log)

        const loaded = await persistence.load(m.id)
        expect(loaded.meta).toMatchObject({ version: SESSION_FORMAT_VERSION, id: m.id, cwd: '/work' })
        expect(loaded.events).toEqual(log)
      } finally {
        await dispose()
      }
    })

    it('rejects a fractional creation timestamp without reserving its session id', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = { ...meta('fractional-created-at'), createdAt: 1.5 }
        await expect(persistence.create(m))
          .rejects.toThrow('session metadata createdAt must be a non-negative safe integer')

        const valid = meta('fractional-created-at')
        await persistence.create(valid)
        await persistence.append(valid.id, oneTurnLog())
        expect((await persistence.load(valid.id)).meta.createdAt).toBe(valid.createdAt)
      } finally {
        await dispose()
      }
    })

    it('crash recovery: load preserves an interrupted (unclosed) turn and closes it with turn/end {interrupted}', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('interrupted')
        await persistence.create(m)
        await persistence.append(m.id, oneTurnLog()) // turn 1, committed (seqs 0..5)
        // A second turn that crashed mid-flight: turn/start + step/start were
        // durably written, but no step/end / turn/end ever arrived.
        await persistence.append(m.id, [
          { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
          { type: 'step/start', seq: 7, time: 8, data: { turn: 2, step: 1 } },
        ])
        const beforeRepair = (await persistence.listSnapshots())
          .find(snapshot => snapshot.header.id === m.id)?.revision

        const inspected = await persistence.inspect(m.id)
        const afterInspect = (await persistence.listSnapshots())
          .find(snapshot => snapshot.header.id === m.id)?.revision
        expect(afterInspect).toBe(beforeRepair)
        expect(inspected.events.map(e => e.type)).toEqual([
          'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
          'turn/start', 'step/start', 'step/end', 'turn/end',
        ])

        // load PRESERVES the interrupted turn's events (a turn can be huge — they
        // must not be truncated) and closes the orphaned turn with synthetic
        // boundary events: step/end (the step was open) then turn/end {interrupted}.
        const loaded = await persistence.load(m.id)
        const afterRepair = (await persistence.listSnapshots())
          .find(snapshot => snapshot.header.id === m.id)?.revision
        expect(afterRepair).not.toBe(beforeRepair)
        expect(loaded.events.map(e => e.type)).toEqual([
          'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end', // turn 1
          'turn/start', 'step/start', 'step/end', 'turn/end', // turn 2: real events + synthetic closers
        ])
        expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        const last = loaded.events.at(-1)!
        expect(last.type === 'turn/end' && last.data.reason).toEqual({ kind: 'interrupted' })

        // The closed log is durable and continuable: a fresh append continues at
        // the balanced length (seq 10), and a reload round-trips identically.
        await persistence.append(m.id, [
          { type: 'turn/start', seq: 10, time: 9, data: { turn: 3 } },
          { type: 'turn/end', seq: 11, time: 10, data: { turn: 3, reason: { kind: 'completed' } } },
        ])
        const reloaded = await persistence.load(m.id)
        expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      } finally {
        await dispose()
      }
    })

    it('crash recovery: an unstarted assistant tool request gets a retryable synthetic result', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('interrupted-toolcall')
        await persistence.create(m)
        await persistence.append(m.id, oneTurnLog()) // turn 1, committed (seqs 0..5)
        // Turn 2 crashed AFTER the assistant message asked for a tool call but
        // BEFORE the tool/result was written (the loop runs tools after logging
        // the assistant message — a process killed mid-tool lands exactly here).
        await persistence.append(m.id, [
          { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
          { type: 'step/start', seq: 7, time: 8, data: { turn: 2, step: 1 } },
          { type: 'assistant/message', seq: 8, time: 9, data: {
            turn: 2, step: 1,
            message: createMessage({
              role: 'assistant',
              content: [
                { type: 'tool-call', id: CallId('call-x'), name: 'bash', arguments: '{}' },
              ],
              source: {
                kind: 'model',
                ...{ provider: 'mock', model: 'mock' },
              },
            }),
          }, surfaceOp: 'append' },
        ])

        const loaded = await persistence.load(m.id)
        // The orphaned call is answered by a synthetic error tool/result BEFORE
        // step/end + turn/end {interrupted}, so the step (and turn) are balanced
        // and a resumed session derives a valid transcript (no dangling call).
        expect(loaded.events.map(e => e.type)).toEqual([
          'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end', // turn 1
          'turn/start', 'step/start', 'assistant/message', 'tool/result', 'step/end', 'turn/end', // turn 2
        ])
        const synthetic = loaded.events.find(e => e.type === 'tool/result')
        expect(synthetic?.type === 'tool/result' && synthetic.data).toMatchObject({
          message: {
            source: { kind: 'tool', callId: CallId('call-x') },
            content: [{ type: 'tool-result', toolCallId: CallId('call-x'), isError: true }],
          },
          error: { code: TOOL_NOT_STARTED },
        })
        // The synthetic result carries the SAME callId as the orphaned tool-call,
        // so deriveMessages() pairs them — no provider-invalid dangling call.
        const call = loaded.events.findLast(e => e.type === 'assistant/message')
        const callId = call?.type === 'assistant/message'
          && call.data.message.content.find(b => b.type === 'tool-call')
        expect(callId && callId.type === 'tool-call' && callId.id).toBe(CallId('call-x'))
      } finally {
        await dispose()
      }
    })

    it('crash recovery: a recorded tool call with no result tells the model to assess retry risk', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('unknown-tool-outcome')
        await persistence.create(m)
        await persistence.append(m.id, [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
          { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
          { type: 'assistant/message', seq: 2, time: 3, data: {
            turn: 1, step: 1,
            message: createMessage({
              role: 'assistant',
              content: [
                { type: 'tool-call', id: CallId('call-risk'), name: 'write', arguments: '{}' },
              ],
              source: {
                kind: 'model',
                ...{ provider: 'mock', model: 'mock' },
              },
            }),
          }, surfaceOp: 'append' },
          { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, callId: CallId('call-risk'), name: 'write', arguments: '{}' } },
        ])

        const loaded = await persistence.load(m.id)
        const synthetic = loaded.events.find(e => e.type === 'tool/result')
        expect(synthetic?.type === 'tool/result' && synthetic.data.error).toEqual({
          name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN,
        })
        if (synthetic?.type !== 'tool/result' || synthetic.data.message.content[0].content[0]?.type !== 'text') {
          throw new Error('expected a text tool result')
        }
        expect(synthetic.data.message.content[0].content[0].text).toContain('retry only if the operation is read-only or idempotent')
        expect(synthetic.data.message.content[0].content[0].text).toContain('if it may have side effects, first verify external state or ask the user')
        const resumed = Session.create(m.id, loaded.events, loaded.meta)
        const resumedResult = resumed.deriveMessages().find(message => message.content.some(block => block.type === 'tool-result'))
        expect(resumedResult?.content[0]).toMatchObject({
          type: 'tool-result', toolCallId: CallId('call-risk'), isError: true,
        })
      } finally {
        await dispose()
      }
    })

    it('list() excludes a created-but-never-appended (zero-event) session', async () => {
      const { persistence, dispose } = await make()
      try {
        await persistence.create(meta('empty'))
        expect((await persistence.list()).map(m => m.id)).not.toContain(SessionId('empty'))
        expect((await persistence.listSnapshots()).map(snapshot => snapshot.header.id))
          .not.toContain(SessionId('empty'))
      } finally {
        await dispose()
      }
    })

    it('rejects pre-aborted observation reads with the exact cancellation reason', async () => {
      const { persistence, dispose } = await make()
      try {
        const reason = new Error('persistence observation cancelled')
        const controller = new AbortController()
        await expect(persistence.listSnapshots(controller.signal)).resolves.toEqual([])
        controller.abort(reason)

        await expect(persistence.list(controller.signal)).rejects.toBe(reason)
        await expect(persistence.listSnapshots(controller.signal)).rejects.toBe(reason)
        await expect(persistence.inspect(SessionId('cancelled-inspect'), controller.signal))
          .rejects.toBe(reason)
        await expect(persistence.readFrom(SessionId('cancelled-read-from'), 0, controller.signal))
          .rejects.toBe(reason)
      } finally {
        await dispose()
      }
    })

    it('readFrom returns exactly the stored suffix from the requested seq, without mutating the log', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('read-from', '/work')
        const log = oneTurnLog()
        await persistence.create(m)
        await persistence.append(m.id, log)

        const whole = await persistence.readFrom(m.id, 0)
        expect(whole.meta).toMatchObject({ id: m.id, cwd: '/work' })
        expect(whole.events).toEqual(log)

        const suffix = await persistence.readFrom(m.id, 3)
        expect(suffix.events).toEqual(log.slice(3))
        expect(suffix.events[0]?.seq).toBe(3)

        // At/past the stored end: an empty tail, never an error.
        await expect(persistence.readFrom(m.id, log.length)).resolves.toMatchObject({ events: [] })
        await expect(persistence.readFrom(m.id, log.length + 100)).resolves.toMatchObject({ events: [] })

        // Non-mutating: an interrupted-turn log is served as stored, no closers.
        await persistence.append(m.id, [
          { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
        ])
        const tail = await persistence.readFrom(m.id, 6)
        expect(tail.events.map(event => event.type)).toEqual(['turn/start'])

        await expect(persistence.readFrom(SessionId('absent-read-from'), 0)).rejects.toThrow('not found')
        await expect(persistence.readFrom(m.id, -1)).rejects.toThrow('non-negative safe integer')
        await expect(persistence.readFrom(m.id, 1.5)).rejects.toThrow('non-negative safe integer')
      } finally {
        await dispose()
      }
    })

    it('readHistoryPage returns contiguous message-boundary pages from the tail', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('history-page', '/work')
        const log = oneTurnLog()
        await persistence.create(m)
        await persistence.append(m.id, log)

        const tail = await persistence.readHistoryPage(m.id, { maxMessages: 1 })
        expect(tail.events.map(event => event.seq)).toEqual([3, 4, 5])
        expect(tail.hasMore).toBe(true)

        const preferredTail = await persistence.readHistoryPage(m.id, {
          maxMessages: 1,
          preferLatestCheckpoint: true,
        })
        expect(preferredTail.events.map(event => event.seq)).toEqual([3, 4, 5])
        expect(preferredTail.hasMore).toBe(true)

        const earlier = await persistence.readHistoryPage(m.id, {
          beforeSeq: tail.events[0]!.seq,
          maxMessages: 1,
        })
        expect(earlier.events.map(event => event.seq)).toEqual([1, 2])
        expect(earlier.hasMore).toBe(true)

        const oldest = await persistence.readHistoryPage(m.id, {
          beforeSeq: earlier.events[0]!.seq,
          maxMessages: 1,
        })
        expect(oldest.events.map(event => event.seq)).toEqual([0])
        expect(oldest.hasMore).toBe(false)
      } finally {
        await dispose()
      }
    })

    // A preferred initial page must not widen its window merely because no
    // checkpoint exists. The decode-work bound this protects is measured in
    // the JSONL suite, where reverse frame decoding is observable.
    it('readHistoryPage keeps a preferred initial page bounded when no checkpoint exists', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('history-unbounded-guard', '/work')
        const log: SessionEvent[] = []
        let seq = 0
        const turns = 60
        for (let turn = 1; turn <= turns; turn += 1) {
          log.push({ type: 'turn/start', seq: seq++, time: seq, data: { turn } })
          log.push({
            type: 'user/message',
            seq: seq++,
            time: seq,
            data: freezeMessage({
              id: MessageId(`guard-user-${String(turn)}`),
              role: 'user',
              content: [{ type: 'text', text: `q${String(turn)}` }],
              source: { kind: 'user' },
            }),
            surfaceOp: 'append',
          })
          log.push({ type: 'step/start', seq: seq++, time: seq, data: { turn, step: 1 } })
          log.push({
            type: 'assistant/message',
            seq: seq++,
            time: seq,
            data: {
              turn,
              step: 1,
              message: freezeMessage({
                id: MessageId(`guard-assistant-${String(turn)}`),
                role: 'assistant',
                content: [{ type: 'text', text: `a${String(turn)}` }],
                source: { kind: 'model', provider: 'mock', model: 'mock' },
              }),
            },
            surfaceOp: 'append',
          })
          log.push({ type: 'step/end', seq: seq++, time: seq, data: { turn, step: 1 } })
          log.push({ type: 'turn/end', seq: seq++, time: seq, data: { turn, reason: { kind: 'completed' } } })
        }
        await persistence.create(m)
        await persistence.append(m.id, log)

        const ordinary = await persistence.readHistoryPage(m.id, { maxMessages: 10 })
        const preferred = await persistence.readHistoryPage(m.id, {
          maxMessages: 10,
          preferLatestCheckpoint: true,
        })
        // Identical page: preferring a checkpoint that does not exist must not
        // widen the window, and must not degrade into a full-log read.
        expect(preferred.events.map(event => event.seq)).toEqual(ordinary.events.map(event => event.seq))
        expect(preferred.hasMore).toBe(true)
        expect(preferred.events.length).toBeLessThan(log.length)
        expect(preferred.events[0]!.seq).toBeGreaterThan(0)
      } finally {
        await dispose()
      }
    })

    // The search bound is observable through its boundary: a checkpoint below
    // the window must be left alone (page equals the ordinary quota page),
    // while one inside the window must still cut the page. A backend that drops
    // its bound and scans to the head of the log fails the first assertion.
    it('readHistoryPage searches for a checkpoint only within its bounded window', async () => {
      const maxMessages = 2
      const inWindowMessages = CHECKPOINT_SEARCH_MESSAGE_BUDGET + maxMessages - 1
      // One message past the window: reachable only by an unbounded search.
      const outOfWindowMessages = CHECKPOINT_SEARCH_MESSAGE_BUDGET + maxMessages + 1

      /** Log whose only checkpoint sits `laterMessages` append messages above the tail. */
      const checkpointedLog = (laterMessages: number): SessionEvent[] => {
        let seq = 0
        const log: SessionEvent[] = [
          { type: 'turn/start', seq: seq++, time: 1, data: { turn: 1 } },
          {
            type: 'user/message',
            seq: seq++,
            time: 2,
            data: freezeMessage({
              id: MessageId('window-original'),
              role: 'user',
              content: [{ type: 'text', text: 'superseded' }],
              source: { kind: 'user' },
            }),
            surfaceOp: 'append',
          },
          { type: 'turn/end', seq: seq++, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        ]
        const transactionStart = seq
        log.push({ type: 'turn/start', seq: seq++, time: 4, data: { turn: 2 } })
        log.push({
          type: 'user/message',
          seq: seq++,
          time: 5,
          data: freezeMessage({
            id: MessageId('window-checkpoint'),
            role: 'user',
            content: [{ type: 'text', text: 'condensed context' }],
            source: { kind: 'plugin', plugin: 'compact' },
          }),
          surfaceOp: { op: 'replace', start: 1, end: 1 },
          sourceEventSeqs: [transactionStart, 1],
        })
        for (let message = 1; message <= laterMessages; message += 1) {
          log.push({
            type: 'user/message',
            seq: seq++,
            time: 5 + message,
            data: freezeMessage({
              id: MessageId(`window-later-${String(message)}`),
              role: 'user',
              content: [{ type: 'text', text: `later ${String(message)}` }],
              source: { kind: 'user' },
            }),
            surfaceOp: 'append',
          })
        }
        log.push({
          type: 'turn/end',
          seq: seq++,
          time: 6 + laterMessages,
          data: { turn: 2, reason: { kind: 'completed' } },
        })
        return log
      }

      const pageFor = async (laterMessages: number, id: string) => {
        const { persistence, dispose } = await make()
        try {
          const m = meta(id, '/work')
          await persistence.create(m)
          await persistence.append(m.id, checkpointedLog(laterMessages))
          return {
            ordinary: await persistence.readHistoryPage(m.id, { maxMessages }),
            preferred: await persistence.readHistoryPage(m.id, {
              maxMessages,
              preferLatestCheckpoint: true,
            }),
          }
        } finally {
          await dispose()
        }
      }

      const inWindow = await pageFor(inWindowMessages, 'history-window-inside')
      // Found: the page starts at the cited transaction start (seq 3), which is
      // strictly below the ordinary quota page's first event.
      expect(inWindow.preferred.events[0]!.seq).toBe(3)
      expect(inWindow.preferred.events[0]!.seq).toBeLessThan(inWindow.ordinary.events[0]!.seq)
      expect(inWindow.preferred.hasMore).toBe(true)

      const outOfWindow = await pageFor(outOfWindowMessages, 'history-window-outside')
      // Not found: the checkpoint is past the bounded window, so the preferred
      // page is exactly the ordinary quota page.
      expect(outOfWindow.preferred.events.map(event => event.seq))
        .toEqual(outOfWindow.ordinary.events.map(event => event.seq))
      expect(outOfWindow.preferred.events[0]!.seq).toBeGreaterThan(3)
    })

    it('readHistoryPage can stop an initial page at the latest replacement checkpoint transaction', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('history-checkpoint', '/work')
        const checkpoint = freezeMessage({
          id: MessageId('history-checkpoint-message'),
          role: 'user',
          content: [{ type: 'text', text: 'condensed context' }],
          source: { kind: 'plugin', plugin: 'compact' },
        })
        const recent = freezeMessage({
          id: MessageId('history-checkpoint-recent'),
          role: 'user',
          content: [{ type: 'text', text: 'recent prompt' }],
          source: { kind: 'user' },
        })
        const answer = freezeMessage({
          id: MessageId('history-checkpoint-answer'),
          role: 'assistant',
          content: [{ type: 'text', text: 'recent answer' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        })
        const followup = freezeMessage({
          id: MessageId('history-checkpoint-followup'),
          role: 'user',
          content: [{ type: 'text', text: 'followup prompt' }],
          source: { kind: 'user' },
        })
        const followupAnswer = freezeMessage({
          id: MessageId('history-checkpoint-followup-answer'),
          role: 'assistant',
          content: [{ type: 'text', text: 'followup answer' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        })
        const log: SessionEvent[] = [
          ...oneTurnLog(),
          { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
          {
            type: 'user/message',
            seq: 7,
            time: 8,
            data: checkpoint,
            surfaceOp: { op: 'replace', start: 1, end: 1 },
            sourceEventSeqs: [6, 1, 2, 3],
          },
          { type: 'user/message', seq: 8, time: 9, data: recent, surfaceOp: 'append' },
          { type: 'step/start', seq: 9, time: 10, data: { turn: 2, step: 1 } },
          {
            type: 'assistant/message',
            seq: 10,
            time: 11,
            data: { turn: 2, step: 1, message: answer },
            surfaceOp: 'append',
          },
          { type: 'step/end', seq: 11, time: 12, data: { turn: 2, step: 1 } },
          { type: 'turn/end', seq: 12, time: 13, data: { turn: 2, reason: { kind: 'completed' } } },
          { type: 'turn/start', seq: 13, time: 14, data: { turn: 3 } },
          { type: 'user/message', seq: 14, time: 15, data: followup, surfaceOp: 'append' },
          { type: 'step/start', seq: 15, time: 16, data: { turn: 3, step: 1 } },
          {
            type: 'assistant/message',
            seq: 16,
            time: 17,
            data: { turn: 3, step: 1, message: followupAnswer },
            surfaceOp: 'append',
          },
          { type: 'step/end', seq: 17, time: 18, data: { turn: 3, step: 1 } },
          { type: 'turn/end', seq: 18, time: 19, data: { turn: 3, reason: { kind: 'completed' } } },
        ]
        await persistence.create(m)
        await persistence.append(m.id, log)

        const tail = await persistence.readHistoryPage(m.id, {
          maxMessages: 1,
          preferLatestCheckpoint: true,
        })
        expect(tail.events.map(event => event.seq)).toEqual([
          6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
        ])
        expect(tail.hasMore).toBe(true)

        const older = await persistence.readHistoryPage(m.id, {
          beforeSeq: 6,
          maxMessages: 50,
        })
        expect(older.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
        expect(older.hasMore).toBe(false)
      } finally {
        await dispose()
      }
    })

    it('lists stable lightweight revisions that change after an append', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s2')
        await persistence.create(m)
        await persistence.append(m.id, oneTurnLog())
        expect((await persistence.list()).map(x => x.id)).toContain(m.id)
        const first = (await persistence.listSnapshots()).find(snapshot => snapshot.header.id === m.id)
        const repeated = (await persistence.listSnapshots()).find(snapshot => snapshot.header.id === m.id)
        expect(first).toBeDefined()
        expect(repeated?.revision).toBe(first?.revision)

        await persistence.append(m.id, [{
          type: 'turn/start',
          seq: 6,
          time: 7,
          data: { turn: 2 },
        }])
        const changed = (await persistence.listSnapshots()).find(snapshot => snapshot.header.id === m.id)
        expect(changed?.revision).not.toBe(first?.revision)
      } finally {
        await dispose()
      }
    })

    it('append rejects a batch whose first seq does not match the stored next-seq', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s3')
        await persistence.create(m)
        await persistence.append(m.id, oneTurnLog()) // seqs 0..5, next-seq = 6
        // A re-append of an already-stored seq must be rejected, not duplicated.
        const restated = oneTurnLog()
        await expect(persistence.append(m.id, restated)).rejects.toThrow()
      } finally {
        await dispose()
      }
    })

    it('append rejects a mid-batch seq gap', async () => {
      const { persistence, dispose } = await make()
      try {
        const m = meta('s4')
        await persistence.create(m)
        const gapped: SessionEvent[] = [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
          { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }, // gap: missing seq 1
        ]
        await expect(persistence.append(m.id, gapped)).rejects.toThrow()
      } finally {
        await dispose()
      }
    })

    it('append rejects non-JSON-serializable event data, naming the event type', async () => {
      const { persistence, dispose } = await make()
      try {
        // Every value `isJsonValue` rejects must be rejected by the backend, not just BigInt —
        // otherwise a backend could pass this contract while still accepting values that
        // corrupt the durable round-trip. Each value is carried in a plugin-added field on one
        // user message so the contract covers the complete JSON-value boundary.
        const cyclic: Record<string, unknown> = { type: 'text', text: 'x' }
        cyclic['self'] = cyclic
        const badValues: unknown[] = [
          1n,                  // BigInt
          undefined,           // dropped by JSON.stringify
          Infinity,            // → null
          () => 0,             // function
          Symbol('s'),         // symbol
          new Map(),           // exotic object
          cyclic,              // circular ref
        ]
        for (const [i, bad] of badValues.entries()) {
          // A fresh session per value isolates each rejection (a rejected append
          // must leave no state behind, but isolating keeps the assertion clean).
          const mi = meta(`s5-${i}`)
          await persistence.create(mi)
          const events = [
            {
              type: 'user/message',
              seq: 0,
              time: 1,
              data: {
                id: MessageId(`invalid-json-${i}`),
                role: 'user',
                content: [{ type: 'text', text: 'x' }],
                source: { kind: 'user' },
                extra: bad,
              },
            },
          ] as unknown as SessionEvent[]
          await expect(persistence.append(mi.id, events)).rejects.toThrow(/losslessly JSON-serializable/)
        }
      } finally {
        await dispose()
      }
    })

    it('deletes one materialized session idempotently and permits a new lifecycle under the id', async () => {
      const { persistence, dispose } = await make()
      try {
        const original = meta('deleted')
        await persistence.create(original)
        await persistence.append(original.id, oneTurnLog())

        await expect(persistence.delete(original.id)).resolves.toBe(true)
        await expect(persistence.delete(original.id)).resolves.toBe(false)
        await expect(persistence.load(original.id)).rejects.toThrow('not found')
        expect((await persistence.list()).some(header => header.id === original.id)).toBe(false)

        const replacement = { ...original, createdAt: original.createdAt + 1 }
        await persistence.create(replacement)
        await persistence.append(replacement.id, oneTurnLog())
        expect((await persistence.load(replacement.id)).meta.createdAt).toBe(replacement.createdAt)
      } finally {
        await dispose()
      }
    })
  })
}
