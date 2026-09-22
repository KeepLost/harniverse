/**
 * The browser panel store: occupancy plus the bounded, app-owned navigation
 * history (dedup, forward-tail truncation, oldest-drop cap) through the
 * real snapshot-store engine.
 */
import { describe, expect, it } from 'vitest'
import { createBrowserViewStore } from '../src/client/history.ts'

/** Fresh store instance over the real engine. */
function fresh() {
  return createBrowserViewStore().create()
}

describe('createBrowserViewStore', () => {
  it('starts closed with an empty trail', () => {
    const instance = fresh()
    expect(instance.getSnapshot()).toEqual({ open: false, entries: [], cursor: -1 })
  })

  it('carries the occupancy fact', () => {
    const instance = fresh()
    instance.actions.setOpen(true)
    expect(instance.getSnapshot().open).toBe(true)
    instance.actions.setOpen(false)
    expect(instance.getSnapshot().open).toBe(false)
  })

  it('records the first visit at cursor 0', () => {
    const instance = fresh()
    instance.actions.visit('https://example.com/')
    expect(instance.getSnapshot()).toEqual({ open: false, entries: ['https://example.com/'], cursor: 0 })
  })

  it('collapses consecutive duplicate visits', () => {
    const instance = fresh()
    instance.actions.visit('https://example.com/')
    instance.actions.visit('https://example.com/')
    expect(instance.getSnapshot().entries).toEqual(['https://example.com/'])
    expect(instance.getSnapshot().cursor).toBe(0)
  })

  it('truncates the forward tail when navigating from the past', () => {
    const instance = fresh()
    instance.actions.visit('https://a.example/')
    instance.actions.visit('https://b.example/')
    instance.actions.back()
    instance.actions.visit('https://c.example/')
    expect(instance.getSnapshot().entries).toEqual(['https://a.example/', 'https://c.example/'])
    expect(instance.getSnapshot().cursor).toBe(1)
  })

  it('moves back and forward within the trail and ignores moves past the ends', () => {
    const instance = fresh()
    instance.actions.back()
    instance.actions.forward()
    expect(instance.getSnapshot().cursor).toBe(-1)
    instance.actions.visit('https://a.example/')
    instance.actions.visit('https://b.example/')
    instance.actions.back()
    expect(instance.getSnapshot().cursor).toBe(0)
    instance.actions.back()
    expect(instance.getSnapshot().cursor).toBe(0)
    instance.actions.forward()
    instance.actions.forward()
    expect(instance.getSnapshot().cursor).toBe(1)
  })

  it('caps the trail at 50 entries, dropping the oldest', () => {
    const instance = fresh()
    for (let index = 0; index < 52; index += 1) instance.actions.visit(`https://host-${index}.example/`)
    const snapshot = instance.getSnapshot()
    expect(snapshot.entries.length).toBe(50)
    expect(snapshot.entries[0]).toBe('https://host-2.example/')
    expect(snapshot.entries.at(-1)).toBe('https://host-51.example/')
    expect(snapshot.cursor).toBe(49)
  })

  it('returns distinct snapshots per instance (no module-level singleton)', () => {
    const a = fresh()
    const b = fresh()
    a.actions.visit('https://a.example/')
    expect(b.getSnapshot().entries).toEqual([])
  })
})
