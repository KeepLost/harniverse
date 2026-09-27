import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Shared open/closed state for the remote-host browser view. */
export interface RemoteHostsViewState { open: boolean }
type RemoteHostsViewActions = { setOpen: (draft: RemoteHostsViewState, open: boolean) => void }

/**
 * Create a fresh remote-host view store for one registration lifetime.
 * @returns an isolated store handle.
 */
export function createRemoteHostsViewStore(): EngineStoreHandle<RemoteHostsViewState, RemoteHostsViewActions> {
  return defineStore({ init: (): RemoteHostsViewState => ({ open: false }), actions: { setOpen: (draft, open) => { draft.open = open } } })
}
