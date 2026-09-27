import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

export interface RemoteHostsViewState { open: boolean }
type RemoteHostsViewActions = { setOpen: (draft: RemoteHostsViewState, open: boolean) => void }

export function createRemoteHostsViewStore(): EngineStoreHandle<RemoteHostsViewState, RemoteHostsViewActions> {
  return defineStore({ init: (): RemoteHostsViewState => ({ open: false }), actions: { setOpen: (draft, open) => { draft.open = open } } })
}
