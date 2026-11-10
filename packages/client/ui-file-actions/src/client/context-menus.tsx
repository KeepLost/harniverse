/** Original-file menu contributions owned by the file-action capability. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileActions, FileActionSource } from '../types.ts'
import { fileMediaUrl } from '@deepseek-ai/dsh-util-workspace-path'
import mime from 'mime'
import type { FileActionKey } from './locales.ts'

/**
 * Register original-byte operations without requiring an application-opening plugin.
 * The harniverse adaptation maps the menu's session-scoped targets onto the
 * workspace-keyed inspection face: targets carry `sessionId`, while reads are
 * keyed by the Workspace that accounts for that session, resolved through the
 * runtime's workspace list. Host-side reveal is intentionally absent (saves are
 * client-side browser downloads), so notices never carry a reveal action.
 * @param ctx - menu and workspace-inspection services.
 * @param actions - file-action owner.
 * @param t - localized labels and feedback.
 */
export function registerFileMenus(ctx: Context, actions: FileActions, t: (key: FileActionKey) => string): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'file actions: feedback lifetime')
  const workspaceOf = (sessionId: SessionId): WorkspaceId | undefined =>
    ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId))?.workspaceId
  const read = (workspaceId: WorkspaceId, path: string, mediaType: string) => async (signal: AbortSignal): Promise<Blob> => {
    const { dataBase64 } = await ctx.workspaces.readFileBytes(workspaceId, path, {}, signal)
    lifetime.signal.throwIfAborted()
    const bytes = Uint8Array.from(atob(dataBase64), character => character.charCodeAt(0))
    return new Blob([bytes], ...(mediaType === '' ? [] : [{ type: mediaType }]))
  }
  const save = async (source: FileActionSource, mode: 'download' | 'saveAs'): Promise<void> => {
    const result = await actions.save(source, mode)
    lifetime.signal.throwIfAborted()
    if (result.status === 'cancelled') return
    ctx.contextMenus.notify(
      t(result.status === 'requested' ? 'menu.downloadStarted' : mode === 'download' ? 'menu.downloaded' : 'menu.saved'),
      true,
    )
  }
  const copy = async (source: FileActionSource): Promise<void> => {
    await actions.copyImage(source)
    ctx.contextMenus.notify(t('menu.copied'), true)
  }
  ctx.effect(() => ctx.contextMenus.register({
    id: 'file-actions.file', target: 'file', order: 200,
    resolve: async ({ sessionId, path }, signal) => {
      const workspaceId = workspaceOf(sessionId)
      let absolutePath: string | undefined
      if (workspaceId !== undefined) {
        try {
          absolutePath = (await ctx.workspaces.statFile(workspaceId, path, signal)).absolutePath
        } catch {
          // Failed metadata disables operations that require the source file.
          signal.throwIfAborted()
        }
      }
      signal.throwIfAborted()
      const available = workspaceId !== undefined && absolutePath !== undefined
      const mediaType = mime.getType(path) ?? ''
      const source: FileActionSource = {
        url: fileMediaUrl(document.baseURI, absolutePath ?? path) ?? path,
        name: path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1),
        mediaType,
        ...(workspaceId === undefined ? {} : { read: read(workspaceId, path, mediaType) }),
      }
      return [
        ...mediaType.startsWith('image/') ? [
          { id: 'copyImage', icon: { key: 'file-actions.copy' }, separatorBefore: true, failureLabel: t('menu.copyFailed'),
            label: t('menu.copyImage'), disabled: !available, run: () => copy(source) },
        ] : [],
        ...mediaType.startsWith('image/') || !actions.canSaveAs ? [
          { id: 'download', icon: { key: 'file-actions.download' }, failureLabel: t('menu.saveFailed'),
            label: t('menu.download'), disabled: !available, run: () => save(source, 'download') },
        ] : [],
        ...actions.canSaveAs ? [
          { id: 'saveAs', icon: { key: 'file-actions.save' }, failureLabel: t('menu.saveFailed'), label: t('menu.saveAs'),
            disabled: !available, run: () => save(source, 'saveAs') },
        ] : [],
      ]
    },
  }), 'file actions: file menu')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'file-actions.image', target: 'image', order: 100,
    resolve: (target) => {
      const { sessionId, path } = target
      const workspaceId = sessionId === undefined ? undefined : workspaceOf(sessionId)
      const name = target.name ?? path?.split(/[\\/]/u).pop()
      const mediaType = target.mediaType || mime.getType(name ?? target.url) || undefined
      const source: FileActionSource = {
        ...target,
        ...(name === undefined ? {} : { name }),
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(path === undefined || workspaceId === undefined ? {} : {
          read: read(workspaceId, path, mediaType ?? ''),
        }),
      }
      return [
        { id: 'copy', icon: { key: 'file-actions.copy' }, failureLabel: t('menu.copyFailed'), label: t('menu.copyImage'), run: () => copy(source) },
        { id: 'download', icon: { key: 'file-actions.download' }, failureLabel: t('menu.saveFailed'), label: t('menu.download'), run: () => save(source, 'download') },
        ...actions.canSaveAs ? [
          { id: 'saveAs', icon: { key: 'file-actions.save' }, failureLabel: t('menu.saveFailed'), label: t('menu.saveAs'),
            run: () => save(source, 'saveAs') },
        ] : [],
      ]
    },
  }), 'file actions: image menu')
}
