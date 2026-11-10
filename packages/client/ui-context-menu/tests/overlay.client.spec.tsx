// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createMenuStore } from '../src/client/store.ts'
import { MenuOverlay } from '../src/client/View.tsx'
import { apply, inject } from '../src/client/index.ts'
import type { ContextMenuTarget } from '../src/client/types.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('renders legacy Session actions before data contributions and restores More focus after dismissal', async () => {
  const store = createMenuStore().create(), run = vi.fn()
  const close = () => { store.actions.close() }
  const useStore = bindSnapshotSelector(store)
  const view = render(<>
    <button onClick={() => { store.actions.open({ kind: 'session', value: { sessionId: SessionId('clicked'), displayTitle: 'Clicked' } }, { x: 20, y: 30 }) }}>More</button>
    <MenuOverlay t={key => key === 'back' ? 'Back' : 'Failed'} useStore={useStore} actions={store.actions} close={close} select={run}
      renderSlot={(_key, owner: object) => {
        const { target, dismiss } = owner as { target: ContextMenuTarget; dismiss: () => void }
        return <MenuItemButton onSelect={() => {
          if (target.kind === 'session') run(target.value.sessionId)
          dismiss()
        }}>Export</MenuItemButton>
      }} />
  </>)
  const trigger = view.getByRole('button', { name: 'More' })
  trigger.focus(); fireEvent.click(trigger)
  await waitFor(() =>{  expect(view.getByRole('menuitem', { name: 'Export' })).toBe(document.activeElement) })
  fireEvent.click(view.getByRole('menuitem', { name: 'Export' }))
  await waitFor(() =>{  expect(document.activeElement).toBe(trigger) })
  expect(run).toHaveBeenCalledExactlyOnceWith('clicked')
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(view.queryByRole('menu')).toBeNull()
})

it('renders disabled, grouped and nested data actions and keeps feedback after menu dismissal', () => {
  vi.useFakeTimers()
  const store = createMenuStore().create(), select = vi.fn()
  store.actions.open({ kind: 'session', value: { sessionId: SessionId('clicked'), displayTitle: 'Clicked' } }, { x: 20, y: 30 })
  store.actions.items([
    { id: 'plain', label: 'Open' },
    { id: 'blocked', label: 'Unavailable', disabled: true, danger: true, separatorBefore: true },
    { id: 'parent', label: 'Export', children: [{ id: 'child', label: 'Original' }, { id: 'other', label: 'Other', separatorBefore: true }] },
    { id: 'footer', label: 'Folder', afterContent: true },
  ])
  const view = render(<MenuOverlay t={key => key === 'back' ? 'Back' : 'Failed'} useStore={bindSnapshotSelector(store)} actions={store.actions}
    close={() => { store.actions.close() }} select={select} renderSlot={() => null} />)
  expect(view.getByRole('menuitem', { name: 'Unavailable' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(view.getByRole('menuitem', { name: 'Open' }))
  expect(select).toHaveBeenCalledWith('plain')
  fireEvent.click(view.getByRole('menuitem', { name: 'Export' }))
  expect(view.getAllByRole('separator')).toHaveLength(2)
  fireEvent.click(view.getByRole('menuitem', { name: 'Original' }))
  expect(select).toHaveBeenCalledWith('child')
  act(() => { store.actions.exit(true) })
  expect(document.querySelector('[data-menu-phase="replace"]')).not.toBeNull()
  act(() => { store.actions.exit(false) })
  expect(document.querySelector('[data-menu-phase="dismiss"]')).not.toBeNull()
  const reveal = vi.fn()
  act(() => { store.actions.close(); store.actions.notify({ id: 1, text: 'Saved', success: true,
    action: { label: 'Show in Finder', onClick: reveal } }) })
  expect(view.queryByRole('menu')).toBeNull()
  expect(view.getByRole('alert').textContent).toBe('SavedShow in Finder')
  fireEvent.click(view.getByRole('button', { name: 'Show in Finder' }))
  expect(reveal).toHaveBeenCalledOnce()
  act(() => { store.actions.notify({ id: 2, text: 'Copy failed', success: false }) })
  expect(view.getByRole('alert').textContent).toBe('Copy failed')
  expect(view.queryByRole('button', { name: 'Show in Finder' })).toBeNull()
  act(() => { vi.advanceTimersByTime(4000) })
  expect(view.queryByRole('alert')).toBeNull()
})

function PluginIcon({ icon }: PropsRuntime<'contextMenu.icon'>) {
  return <img data-testid="plugin-icon" src={icon.src} alt="" />
}

it('dispatches captured icon keys in rows, submenus and footers and retires renderer registrations on unload', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } }, ({ renderSlot }) =>
    <>{renderSlot('shell.overlay', { rightMode: 'details', rightOpen: false, rightDrawer: false })}</>)
  const menuPlugin = await runtime.mount({ inject, apply })
  const run = vi.fn()
  const contribution = await runtime.mount({ inject: ['contextMenus'], apply(ctx) {
    ctx.effect(() => ctx.contextMenus.register({ id: 'icons', target: 'session', order: 0, resolve: () => [
      { id: 'row', label: 'Open', icon: { key: 'example.icon', src: '/captured.png' }, run },
      { id: 'parent', label: 'Export', children: [{ id: 'child', label: 'Original', icon: { key: 'example.icon' } }] },
      { id: 'footer', label: 'Footer', afterContent: true, icon: { key: 'example.icon' } },
    ] }))
  } })
  const icons = await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.inject('contextMenu.icon', function* () {
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'example.icon' }, PluginIcon)
      yield ctx.slots.register({ name: 'contextMenu.icon', key: 'example.unused' }, () => <span>Unused icon</span>)
    })
  } })
  const view = runtime.renderRoot()
  const open = () => { runtime.ctx.contextMenus.open({ kind: 'session', value: {
    sessionId: SessionId('icons'), displayTitle: 'Icons',
  } }, { x: 20, y: 30 }) }
  act(open)
  await waitFor(() => { expect(view.getAllByTestId('plugin-icon')).toHaveLength(2) })
  expect(view.getByRole('menuitem', { name: 'Open' }).querySelector('img')?.getAttribute('src')).toBe('/captured.png')
  expect(view.queryByText('Unused icon')).toBeNull()
  fireEvent.click(view.getByRole('menuitem', { name: 'Export' }))
  expect(view.getByRole('menuitem', { name: 'Original' }).querySelector('img')).not.toBeNull()
  await icons.dispose()
  expect(view.queryAllByTestId('plugin-icon')).toHaveLength(0)
  fireEvent.click(view.getByRole('menuitem', { name: 'Open' }))
  expect(run).toHaveBeenCalledOnce()
  await contribution.dispose()
  await menuPlugin.dispose()
  expect(runtime.slots.snapshot().some(node => node.name === 'contextMenu.icon')).toBe(false)
})
