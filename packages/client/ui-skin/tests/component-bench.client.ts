/** Shared helpers for the ui-skin component specs: a bound `useSkin` over a real snapshot store, and the zh translator. */
import { useSyncExternalStore } from 'react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import { INITIAL_VIEW, type SkinView } from '../src/client/view.ts'
import { libraryView } from './fixtures.client.ts'

/** The zh translator, assignable to any row's `t` seat. */
export const t = makeTranslate(zh) as never

/** A view with a ready catalog and a writable scope; override any slice. */
function viewOf(patch: Partial<SkinView> = {}): SkinView {
  return {
    ...INITIAL_VIEW,
    library: libraryView(),
    access: { status: 'ready', writable: true, denied: false },
    ...patch,
  }
}

/** The selector hook the renderer would bind over a bare observable. */
function hookOf<T>(instance: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(selector: (state: T) => S): S {
    return selector(useSyncExternalStore(instance.subscribe, instance.getSnapshot))
  }
}

/** A live view store plus the `hooks` seat the components receive. */
export function skinSource(patch: Partial<SkinView> = {}): {
  store: SnapshotStore<SkinView>
  useSkin: ReturnType<typeof hookOf<SkinView>>
  hooks: { skin: SnapshotStore<SkinView> }
  update: (next: Partial<SkinView>) => void
} {
  const store = createSnapshotStore<SkinView>(viewOf(patch))
  return {
    store,
    useSkin: hookOf(store),
    hooks: { skin: store },
    update: (next) => { store.set({ ...store.getSnapshot(), ...next }) },
  }
}
