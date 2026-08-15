import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import NotificationBackend, {
  NotificationEventId,
  type NotificationEnvelope,
} from '../src/index.ts'

class CaptureBackend extends NotificationBackend {
  readonly events: NotificationEnvelope[] = []

  protected enqueue(event: NotificationEnvelope): void {
    this.events.push(event)
  }

  async shutdown(): Promise<void> {}
}

async function setup() {
  const ctx = new Context()
  const fiber = await ctx.plugin(CaptureBackend)
  return { ctx, backend: ctx.notification as CaptureBackend, fiber }
}

const turnSettled = (): NotificationEnvelope<'session.turn-settled'> => ({
  specVersion: 1,
  eventId: NotificationEventId('session-1:4'),
  type: 'session.turn-settled',
  occurredAt: '2026-08-15T12:00:00.000Z',
  subject: { sessionId: 'session-1' as never },
  data: {
    turn: 2,
    seq: 4,
    reason: { kind: 'completed' },
  },
})

describe('NotificationBackend protocol', () => {
  it('snapshots JSON before handing an event to the provider', async () => {
    const { backend, fiber } = await setup()
    const event = turnSettled()

    backend.emit(event)
    event.subject.parentSessionId = 'changed' as never
    event.data.reason = { kind: 'error', error: { code: 'LATE' } }

    expect(backend.events).toEqual([{
      specVersion: 1,
      eventId: 'session-1:4',
      type: 'session.turn-settled',
      occurredAt: '2026-08-15T12:00:00.000Z',
      subject: { sessionId: 'session-1' },
      data: {
        turn: 2,
        seq: 4,
        reason: { kind: 'completed' },
      },
    }])
    await fiber.dispose()
  })

  it.each([
    ['undefined', undefined],
    ['non-finite number', Number.NaN],
    ['bigint', 1n],
    ['non-plain object', new Date()],
  ])('rejects %s before provider handoff', async (_label, invalid) => {
    const { backend, fiber } = await setup()
    const event = turnSettled() as NotificationEnvelope & { invalid?: unknown }
    event.invalid = invalid

    expect(() => { backend.emit(event) }).toThrow('notification event must contain only JSON values')
    expect(backend.events).toEqual([])
    await fiber.dispose()
  })

  it('rejects cyclic objects before provider handoff', async () => {
    const { backend, fiber } = await setup()
    const event = turnSettled() as NotificationEnvelope & { cycle?: unknown }
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    event.cycle = cycle

    expect(() => { backend.emit(event) }).toThrow('notification event must contain only JSON values')
    expect(backend.events).toEqual([])
    await fiber.dispose()
  })

  it('rejects symbol properties and sparse arrays before provider handoff', async () => {
    const { backend, fiber } = await setup()
    const symbolEvent = turnSettled() as NotificationEnvelope & { [key: symbol]: unknown }
    symbolEvent[Symbol('private')] = 'value'
    expect(() => { backend.emit(symbolEvent) }).toThrow('notification event must contain only JSON values')

    const sparseEvent = turnSettled() as NotificationEnvelope & { values?: unknown[] }
    sparseEvent.values = new Array(1)
    expect(() => { backend.emit(sparseEvent) }).toThrow('notification event must contain only JSON values')
    const denseEvent = turnSettled() as NotificationEnvelope & { values?: unknown[] }
    denseEvent.values = [1]
    backend.emit(denseEvent)
    expect(backend.events).toHaveLength(1)
    await fiber.dispose()
  })

  it('registers one backend service and rejects a duplicate', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(CaptureBackend)
    await expect(ctx.plugin(CaptureBackend)).rejects.toThrow()
    await fiber.dispose()
  })
})
