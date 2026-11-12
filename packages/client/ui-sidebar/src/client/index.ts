/** Registers the sidebar shell into the layout-owned slot. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'

export type {
  SidebarFooterActionOwnerProps, SidebarRootComponentProps, SidebarRootInjected,
  SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar shell controls copy. */
    sidebar: SidebarKey
  }
}

/** Dictionary namespace owned by this plugin (shell controls copy). */
const NS = 'sidebar'

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'locale']

/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar: dictionaries')

  const injectProps = (): SidebarRootInjected => {
    // The shell's New Session button rides the runtime's shared action
    // (current Session Workspace, then recent Workspace). The shell menu
    // reads the host description's boot-stable registry snapshot.
    const connection = ctx.get('connection') as { hostDescription: { getSnapshot(): { shell?: {
      default: { entry: string; label: string; stack: 'bash' | 'pwsh'; executablePath: string }
      switchable: boolean
      entries: readonly { id: string; label: string; stack: 'bash' | 'pwsh'; available: boolean; resolvedPath?: string; reason?: string }[]
    } } | undefined } } | undefined
    const shell = connection?.hostDescription.getSnapshot()?.shell
    return {
      startSession: (workspaceId, shellChoice) => {
        if (shellChoice === undefined) ctx.workspaces.startSession(workspaceId)
        else ctx.workspaces.startSession(workspaceId, undefined, undefined, shellChoice)
      },
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
      shellChoices: shell === undefined
        ? undefined
        : shell.entries.map(entry => ({
          id: entry.id, label: entry.label, stack: entry.stack, available: entry.available,
        })),
    }
  }
  ctx.effect(
    () => ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      // The shell owns geometry; ui-workspace registers the whole browsing
      // region (header, search, session list, workspace dialogs), ui-settings
      // registers the foot trigger + settings panel.
      children: {
        'sidebar.header.status': { kind: 'single', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot),
    'ui-sidebar: slot registration',
  )
}
