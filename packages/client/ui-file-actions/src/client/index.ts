/** Original-file actions independent of menu or image component ownership. */
import { IconCopyOutline16, IconDownloadOutline16, IconSaveOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import { BrowserFileActions } from './files.ts'
import { registerFileMenus } from './context-menus.tsx'
import { zh, en, type FileActionKey } from './locales.ts'
import type { DesktopFileActions, FileActions } from '../types.ts'

export type { FileActions, FileActionSource, FileSaveResult } from '../types.ts'
declare module '@deepseek-ai/cordis' {
  interface Context { /** Original-file saving and image clipboard commands. */ fileActions: FileActions }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Original-file action labels and feedback. */
    fileActions: FileActionKey
  }
}

/**
 * Provide the file-action capability; consumers pass captured sources to it.
 * The menu contribution injects the context-menu seat, the slot registry (icon
 * seat), the locale service, and the workspace-keyed runtime inspection face.
 * @param ctx - plugin-owned Client context.
 */
export const inject = ['contextMenus', 'slots', 'locale', 'workspaces']
export function apply(ctx: Context): void {
  // The harniverse Desktop preload exposes its native adapter under the app's bridge namespace.
  const desktop = (window as Window & { harniverseFileActions?: DesktopFileActions }).harniverseFileActions
  const actions = new BrowserFileActions(desktop)
  ctx.provide('fileActions', actions)
  ctx.effect(() => () => { actions.dispose() }, 'file actions: lifetime')
  ctx.effect(() => ctx.locale.register('fileActions', { zh, en }), 'file actions: locale')
  ctx.inject(['contextMenus', 'slots', 'locale', 'workspaces'], (child) => {
    child.slots.inject('contextMenu.icon', function* () {
      for (const [key, Icon] of Object.entries({
        'file-actions.copy': IconCopyOutline16, 'file-actions.download': IconDownloadOutline16,
        'file-actions.save': IconSaveOutline16,
      })) yield child.slots.register({ name: 'contextMenu.icon', key }, Icon)
    })
    registerFileMenus(child, actions, child.locale.bind('fileActions'))
  })
}
