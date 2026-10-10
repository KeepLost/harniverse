import { describe, expect, it, vi } from 'vitest'
import { browserEnvironment, createEnvironmentSource, type MatchMedia } from '../src/client/environment.ts'

function fakeMedia(initial: Record<string, boolean>) {
  const state = { ...initial }
  const listeners = new Map<string, Set<() => void>>()
  const matchMedia: MatchMedia = query => ({
    get matches() { return state[query] === true },
    addEventListener: (_type: string, listener: unknown) => {
      const set = listeners.get(query) ?? new Set()
      listeners.set(query, set)
      set.add(listener as () => void)
    },
    removeEventListener: (_type: string, listener: unknown) => { listeners.get(query)?.delete(listener as () => void) },
  })
  return {
    matchMedia,
    flip(query: string, matches: boolean) {
      state[query] = matches
      for (const listener of [...(listeners.get(query) ?? [])]) listener()
    },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  }
}

describe('environment source', () => {
  it('reads both preferences and follows them live', () => {
    const media = fakeMedia({})
    const source = createEnvironmentSource(media.matchMedia)
    const listener = vi.fn()
    const stop = source.subscribe(listener)
    expect(source.snapshot()).toEqual({ reducedTransparency: false, highContrast: false })
    media.flip('(prefers-reduced-transparency: reduce)', true)
    expect(source.snapshot()).toEqual({ reducedTransparency: true, highContrast: false })
    media.flip('(prefers-contrast: more)', true)
    expect(source.snapshot()).toEqual({ reducedTransparency: true, highContrast: true })
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    expect(media.count()).toBe(0)
    media.flip('(prefers-contrast: more)', false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('reads as unset where the host has no matchMedia', () => {
    const source = createEnvironmentSource(undefined)
    expect(source.snapshot()).toEqual({ reducedTransparency: false, highContrast: false })
    const stop = source.subscribe(() => {})
    stop()
  })

  it('binds the global matchMedia when there is one', () => {
    expect(browserEnvironment().snapshot()).toEqual({ reducedTransparency: false, highContrast: false })
    const media = fakeMedia({ '(prefers-contrast: more)': true })
    vi.stubGlobal('matchMedia', media.matchMedia)
    try {
      expect(browserEnvironment().snapshot()).toEqual({ reducedTransparency: false, highContrast: true })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
