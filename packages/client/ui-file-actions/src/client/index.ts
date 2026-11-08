/** Original-file actions independent of menu or image component ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BrowserFileActions } from './files.ts'
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

/** The native adapter is optional; Web uses its own download and copy capabilities. */
export const inject = ['locale']
/**
 * Provide the file-action capability; consumers pass captured sources to it.
 * @param ctx - plugin-owned Client context.
 */
export function apply(ctx: Context): void {
  const desktop = (window as Window & { dshDesktop?: { fileActions?: DesktopFileActions } }).dshDesktop?.fileActions
  const actions = new BrowserFileActions(desktop)
  ctx.provide('fileActions', actions)
  ctx.effect(() => () => { actions.dispose() }, 'file actions: lifetime')
  ctx.effect(() => ctx.locale.register('fileActions', { zh, en }), 'file actions: locale')
}
