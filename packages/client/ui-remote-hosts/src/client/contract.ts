/**
 * Slot contract for the remote-hosts center view's key-directory flow: the
 * hole the browse directory-picker surface occupies so the operator can
 * locate the SSH key file's directory on the host Harniverse runs on. The
 * owner conversation mirrors ui-workspace's directory-flow holes: the occupant
 * reads `open` to run its interaction and reports exactly one outcome.
 */
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/** Owner share of the key-directory flow hole: the trigger surface's side of the conversation. */
export interface KeyDirectoryFlowOwnerProps {
  /** True while a picking interaction is requested; flipping back to false withdraws the request. */
  open: boolean
  /** True while the owner adopts a picked directory; occupants disable their commit affordances. */
  busy: boolean
  /** The operator picked a directory (absolute host path); the owner adopts it as the key path's directory part. */
  onPicked: (path: string) => void
  /** The operator dismissed the interaction; the owner just closes the flow. */
  onCancel: () => void
  /** The interaction itself failed (listing denied); the owner shows its error surface. */
  onError: (message: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Key-directory flow hole under the remote-hosts center view (declared by the remoteHosts entry). */
    'remoteHosts.keyDirectoryFlow': { kind: 'single'; scope: 'root'; owner: KeyDirectoryFlowOwnerProps }
  }
}

/** Occupancy source share both picking consumers read; the renderer binds it into the selector hook below. */
export type KeyDirectoryPickingInjected = {
  hooks: {
    /** True while the key-directory flow hole is occupied. */
    keyDirectoryFlow: HostObservable<boolean>
  }
}

/** Component-side view of the key-directory picking share: the bound occupancy selector hook. */
export type KeyDirectoryPickingHooks = {
  /** Selector hook over the key-directory flow occupancy. */
  useKeyDirectoryFlow: SnapshotSelectorHook<boolean>
}
