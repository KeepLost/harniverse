// @vitest-environment jsdom
/**
 * SessionProvider area behavior account through the inherited scope binding:
 * empty/body branching off the adapter's current source, blank-incarnation
 * adoption and generation remounts, descriptor prop refreshes without
 * remounts, and the Harniverse generic-area fallback for React-free runtime
 * adapters. Explicit Provider targets arrive with a declared session target
 * type (deferred; the runtime adapter resolves every explicit request to the
 * absent projection until then). Unlike upstream ui-session, Harniverse's
 * root session-maybe scope IS the current selection (the adoption machinery
 * depends on it), so an optional slot without a Provider inherits selection.
 */
import { useState, type ReactNode } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type {
  SessionProviderComponent, StoredEntry, ScopedStandardSourceBinding,
  SlotRendererHost, SlotScopeAdapter, StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '../src/scoped-slots.tsx'

const roots: Context[] = []
afterEach(async () => {
  cleanup()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

function observable<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } },
    set: (next: T) => { value = next; for (const fn of [...subs]) fn() },
  }
}

type SessionBody = (
  renderSlot: (key: string, owner: object) => ReactNode,
  Provider: SessionProviderComponent,
) => ReactNode

function makeHost(body: SessionBody, options: { renderArea?: boolean; optional?: boolean } = {}) {
  const absentBinding: StandardSourceBinding = {
    key: undefined, hooks: { session: undefined }, keyedHooks: {}, props: { sessionId: undefined },
  }
  const current = observable<StandardSourceBinding>(absentBinding)
  const sessionEntries: StoredEntry[] = []
  const root = observable<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
  const sessionAdapter: SlotScopeAdapter = {
    current,
    bindingSource: () => observable(absentBinding),
    // Default on: the production runtime adapter ships no area renderer, so
    // the generic fallback is the covered path; the omission arm below the
    // class exercises the same fallback explicitly.
    ...options.renderArea === false ? {} : {
      renderArea: (binding, { empty, children }) => binding.key === undefined
        ? <>{empty?.() ?? null}</>
        : <>{children}</>,
    },
  }
  const scope = options.optional === true ? 'session-maybe' : 'session'
  const rootEntry: StoredEntry = {
    component: (props: {
      renderSlot: (key: string, owner: object) => ReactNode
      SessionProvider: SessionProviderComponent
    }) => body(props.renderSlot, props.SessionProvider),
    options: {},
    children: { 'k.session': { kind: 'single', scope } },
  }
  const host: SlotRendererHost = {
    subscribe: () => () => {}, getVersion: () => 0,
    entriesOf: key => key === 'root' ? [rootEntry] : sessionEntries,
    entriesOfSlot: key => key === 'root' ? [rootEntry] : sessionEntries,
    reportEntryError: () => {},
    reportFactoryError: () => {},
    specOf: key => key === 'k.session' ? { kind: 'single', scope } : undefined,
    isLive: () => true, storeOf: () => undefined,
    factoryStoreOf: () => undefined,
    retainFactoryOccurrence: () => () => {},
    subscribeFactory: () => () => {},
    getFactoryVersion: () => 0,
    factoryOf: () => undefined,
    isFactoryLive: () => false,
    root, scopeRevision: observable(0), scope: () => sessionAdapter,
  }
  return {
    host,
    current,
    addSession: (id: string) => {
      const ctx = new Context()
      roots.push(ctx)
      const binding: ScopedStandardSourceBinding = {
        key: id, ctx,
        hooks: { session: observable({ sid: id }) },
        keyedHooks: {}, props: { sessionId: id },
      }
      return binding
    },
    registerSession: (entry: StoredEntry) => { sessionEntries.push(entry) },
  }
}

function Counter({ sessionId }: { sessionId: string }) {
  const [count, setCount] = useState(0)
  return <button onClick={() => { setCount(count + 1) }}>{sessionId}:{count}</button>
}

describe('SessionProvider', () => {
  it('renders the empty branch while no session is selected and switches with the binding', () => {
    const h = makeHost((renderSlot, Provider) =>
      <Provider empty={() => <span>empty</span>}>{renderSlot('k.session', {})}</Provider>)
    h.registerSession({ component: ({ sessionId }: { sessionId: string }) => <b>{sessionId}</b>, options: {} })
    const s1 = h.addSession('s1')
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    expect(view.container.textContent).toBe('empty')
    act(() => { h.current.set(s1) })
    expect(view.container.textContent).toBe('s1')
    act(() => { h.current.set({ key: undefined, hooks: { session: undefined }, keyedHooks: {}, props: { sessionId: undefined } }) })
    expect(view.container.textContent).toBe('empty')
  })

  it('renders nothing for the absent binding when the empty branch is omitted', () => {
    const h = makeHost((_renderSlot, Provider) => <Provider><b>session</b></Provider>)
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    expect(view.container.textContent).toBe('')
  })

  it('preserves a resident optional subtree when absence adopts its first Session', () => {
    const h = makeHost((renderSlot, Provider) => {
      const body = renderSlot('k.session', {})
      return <Provider empty={() => body}>{body}</Provider>
    }, { optional: true })
    h.registerSession({
      component: ({ sessionId }: { sessionId?: string }) => <Counter sessionId={sessionId ?? 'blank'} />,
      options: {},
    })
    const first = h.addSession('first')
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    const button = view.getByRole('button')
    fireEvent.click(button)
    expect(button.textContent).toBe('blank:1')

    act(() => { h.current.set(first) })

    expect(view.getByRole('button')).toBe(button)
    expect(button.textContent).toBe('first:1')
  })

  it('resets an adopted optional subtree for a same-id replacement generation', () => {
    const h = makeHost((renderSlot, Provider) => {
      const body = renderSlot('k.session', {})
      return <Provider empty={() => body}>{body}</Provider>
    }, { optional: true })
    h.registerSession({ component: Counter, options: {} })
    const same = h.addSession('same')
    h.current.set(same)
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    const oldButton = view.getByRole('button')
    fireEvent.click(oldButton)
    expect(oldButton.textContent).toBe('same:1')

    act(() => { h.current.set(h.addSession('same')) })

    expect(view.getByRole('button')).not.toBe(oldButton)
    expect(view.getByRole('button').textContent).toBe('same:0')
  })

  it('resets local state on a Session switch and on a same-id new Context generation', () => {
    const h = makeHost((renderSlot, Provider) =>
      <Provider>{renderSlot('k.session', {})}</Provider>)
    h.registerSession({ component: Counter, options: {} })
    const s1 = h.addSession('s1')
    const s2 = h.addSession('s2')
    h.current.set(s1)
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    fireEvent.click(view.getByRole('button'))
    expect(view.container.textContent).toBe('s1:1')
    act(() => { h.current.set(s2) })
    expect(view.container.textContent).toBe('s2:0')
    fireEvent.click(view.getByRole('button'))
    act(() => { h.current.set(h.addSession('s2')) })
    expect(view.container.textContent).toBe('s2:0')
  })

  it('refreshes descriptor props without remounting the live generation', () => {
    const h = makeHost((renderSlot, Provider) =>
      <Provider>{renderSlot('k.session', {})}</Provider>)
    const binding = h.addSession('s1')
    h.registerSession({
      component: ({ sessionId, feature }: { sessionId: string; feature?: string }) =>
        <><Counter sessionId={sessionId} /><b>{feature}</b></>,
      options: {},
    })
    h.current.set(binding)
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    fireEvent.click(view.getByRole('button'))
    act(() => {
      h.current.set({ ...binding, props: { ...binding.props, feature: 'added' } })
    })
    expect(view.container.textContent).toBe('s1:1added')
    act(() => { h.current.set(binding) })
    expect(view.container.textContent).toBe('s1:1')
  })

  it('delivers the Provider seat to entries declaring only optional Session children', () => {
    const h = makeHost((renderSlot, Provider) =>
      <Provider>{renderSlot('k.session', {})}</Provider>, { optional: true })
    const optional = h.addSession('optional')
    h.current.set(optional)
    h.registerSession({ component: ({ sessionId }: { sessionId?: string }) => <b>{sessionId}</b>, options: {} })
    expect(render(<>{createSlotRenderer().renderRoot(h.host, {})}</>).container.textContent).toBe('optional')
  })

  it('falls back to the generic area when the React-free runtime adapter omits a renderer', () => {
    const h = makeHost((renderSlot, Provider) =>
      <Provider empty={() => <i>empty</i>}>{renderSlot('k.session', {})}</Provider>, { renderArea: false })
    h.registerSession({ component: ({ sessionId }: { sessionId: string }) => <b>{sessionId}</b>, options: {} })
    const s1 = h.addSession('s1')
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    expect(view.container.textContent).toBe('empty')
    act(() => { h.current.set(s1) })
    expect(view.container.textContent).toBe('s1')
  })
})
