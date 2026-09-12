import { describe, expect, it } from 'vitest'
import { QuotaBook } from '../src/quota.ts'
import type { QuotaOverrideStore } from '../src/quota.ts'
import type { QuotaOverrideRecord } from '../src/types.ts'

function fakeStore(): QuotaOverrideStore & { rows: Map<string, QuotaOverrideRecord> } {
  const rows = new Map<string, QuotaOverrideRecord>()
  return {
    rows,
    entries: () => rows.entries(),
    put: async (sessionId, record) => {
      rows.set(sessionId, record)
    },
    delete: async sessionId => rows.delete(sessionId),
  }
}

describe('QuotaBook', () => {
  it('pool members ride the global budget; overrides bound their sessions', () => {
    const book = new QuotaBook(() => 1_000)
    expect(book.effectiveLimitBytes('a')).toBe(1_000)
    expect(book.isShared('a')).toBe(true)
    void book.commit('a', 400, 'test')
    expect(book.effectiveLimitBytes('a')).toBe(400)
    expect(book.isShared('a')).toBe(false)
    expect(book.effectiveLimitBytes('b')).toBe(1_000)
  })

  it('admission clamps raises to the budget other sessions have not claimed', () => {
    const book = new QuotaBook(() => 1_000)
    void book.commit('a', 600, 'test')
    expect(book.admit('b', 500)).toEqual({ grantedBytes: 400, clamped: true })
    expect(book.admit('a', 900)).toEqual({ grantedBytes: 900, clamped: false })
    expect(book.admit('c', 1)).toEqual({ grantedBytes: 1, clamped: false })
  })

  it('commits and clears through the durable store', async () => {
    const store = fakeStore()
    const book = new QuotaBook(() => 1_000, store)
    await book.commit('a', 300, 'tool')
    expect(store.rows.get('a')).toMatchObject({ sessionId: 'a', memoryBytes: 300, reason: 'tool' })
    expect(await book.clear('a')).toBe(true)
    expect(store.rows.has('a')).toBe(false)
    expect(await book.clear('a')).toBe(false)
  })

  it('loads persisted rows on boot', async () => {
    const store = fakeStore()
    store.rows.set('old', { sessionId: 'old', memoryBytes: 250, updatedAt: 1, reason: 'board' })
    const book = new QuotaBook(() => 1_000, store)
    const rows = book.load()
    expect(rows).toHaveLength(1)
    expect(book.effectiveLimitBytes('old')).toBe(250)
    expect(book.sessionIds()).toEqual(['old'])
    expect([...book.entries()].map(([id]) => id)).toEqual(['old'])
  })

  it('sweeps abandoned overrides past the TTL', async () => {
    const store = fakeStore()
    const book = new QuotaBook(() => 1_000, store)
    await book.commit('fresh', 100, 'tool')
    store.rows.set('stale', { sessionId: 'stale', memoryBytes: 100, updatedAt: 0, reason: 'tool' })
    book.load()
    await book.sweepAbandoned(10_000, 1_000)
    expect(book.override('fresh')).toBeDefined()
    expect(book.override('stale')).toBeUndefined()
  })
})
