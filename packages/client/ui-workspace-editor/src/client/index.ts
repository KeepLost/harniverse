/**
 * Workspace editor plugin, browser half. Registers the CodeMirror document
 * occupant into ui-workspace's two preview-document holes through
 * `slots.inject()`: the ui-workspace entries may activate later or replace
 * their declarations (machine switches re-register them), and the editor
 * follows those declaration lifetimes while its draft store — created once
 * in this apply — survives them. Wire traffic rides the typed
 * workspaceFileWrite Remote over the shared `/api` channel; saves never pass
 * any request fence. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext, WorkspaceFileWatch } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the preview-document holes' owner contract and SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkspaceEditorController } from './editor-controller.ts'
import type { WorkspaceEditorWire } from './editor-controller.ts'
import { WorkspaceEditorDocument } from './EditorDocument.tsx'
import type { WorkspaceEditorInjected } from './EditorDocument.tsx'
import { createWorkspaceEditorStore } from './stores.ts'
import type { WorkspaceEditorState } from './stores.ts'
import { editorDictionaries } from './locales.ts'
import type { WorkspaceEditorKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The workbench preview editor's copy. */
    workspaceEditor: WorkspaceEditorKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspaceEditor'

/** The typed Remote namespace face the wire binds over. */
type FileWriteRemote = ClientContext['remote']['workspaceFileWrite']

/**
 * Bind the controller's wire over the typed Remote namespace and the
 * optional workspaces watch feed.
 * @param remote - the mounted workspaceFileWrite namespace service.
 * @param boundWatch - the runtime's watch subscription bound to its service, when shipped.
 * @returns the wire the controller drives.
 */
export function buildWire(remote: FileWriteRemote, boundWatch: WorkspaceFileWatch | undefined): WorkspaceEditorWire {
  return {
    open: (workspaceId, path, signal) => remote.open(workspaceId as WorkspaceId, path, signal),
    stat: (workspaceId, path, signal) => remote.stat(workspaceId as WorkspaceId, path, signal),
    save: (workspaceId, path, request, signal) => remote.save(workspaceId as WorkspaceId, path, request, signal),
    ...(boundWatch === undefined ? {} : {
      watchFiles: (workspaceId: string, path: string, signal: AbortSignal) => boundWatch(workspaceId as WorkspaceId, path, signal),
    }),
  }
}

/**
 * Install the page-unload guard: a dirty draft never silently disappears
 * with the page. Environments without a window (node boots, SSR probes)
 * install nothing.
 * @param store - the draft account to watch.
 * @returns the disposer removing the listener.
 */
export function installUnloadGuard(store: { getSnapshot(): WorkspaceEditorState }): () => void {
  if (typeof window === 'undefined') return () => {}
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    const { byMachine } = store.getSnapshot()
    for (const partition of Object.values(byMachine)) {
      for (const entry of Object.values(partition)) {
        if (entry.status === 'dirty' || entry.status === 'saving' || entry.status === 'conflict') {
          event.preventDefault()
          return
        }
      }
    }
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  return () => { window.removeEventListener('beforeunload', onBeforeUnload) }
}

/**
 * Required services: the slot registry, the workspaces watch face, the
 * locale dictionaries, the typed Remote namespace, and the connection (for
 * the machine partition key).
 */
export const inject = ['slots', 'workspaces', 'locale', 'remote', 'remote.workspaceFileWrite', 'connection']

/**
 * Register the editor occupant once both preview-document declarations are
 * on the ledger. The draft store and controller are created once per plugin
 * activation; the controller's machine key follows the live connection
 * target, so machine re-registrations rebind the registrations while every
 * draft entry stays addressed under the machine it was edited on.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, editorDictionaries), 'ui-workspace-editor: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const store = createWorkspaceEditorStore()
  // The mounted namespace service, resolved by name so a stub composition
  // providing the same service answers identically.
  const remote = ctx.get('remote.workspaceFileWrite') as FileWriteRemote
  const controller = new WorkspaceEditorController(store, buildWire(remote, ctx.workspaces.watchFiles?.bind(ctx.workspaces)))
  ctx.effect(() => installUnloadGuard(store), 'ui-workspace-editor: unload guard')

  const injected = (): WorkspaceEditorInjected => {
    const target = connection.target.getSnapshot()
    const machineKey = target.kind === 'host' ? 'host' : `remote:${target.id}`
    return {
      machineKey,
      hooks: { editorState: store },
      // Machine-bound verbs: the registration captured its machine at
      // materialization, and every verb addresses that partition even if the
      // connection target moved on underneath.
      attach: (workspaceId, path) => { controller.attach(machineKey, workspaceId, path) },
      detach: (workspaceId, path, snapshot) => { controller.detach(machineKey, workspaceId, path, snapshot) },
      markDirty: (workspaceId, path) => { controller.markDirty(machineKey, workspaceId, path) },
      save: (workspaceId, path, content) => controller.save(machineKey, workspaceId, path, content),
      confirmOverwrite: (workspaceId, path, content) => controller.confirmOverwrite(machineKey, workspaceId, path, content),
      reload: (workspaceId, path) => controller.reload(machineKey, workspaceId, path),
    }
  }

  // Both declaration lifetimes must be live before the pair installs; the
  // generator makes the two registrations one transactional effect, and
  // either declaration collapsing rolls both back together.
  ctx.slots.inject('workbench.preview.document', () =>
    ctx.slots.inject('shell.overlay.preview.document', function* () {
      yield ctx.slots.register({
        name: 'workbench.preview.document',
        inject: injected,
        locale: NS,
      }, WorkspaceEditorDocument)
      yield ctx.slots.register({
        name: 'shell.overlay.preview.document',
        inject: injected,
        locale: NS,
      }, WorkspaceEditorDocument)
    }))
}
