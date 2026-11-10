/** Shared Web renderer for Client menu contributions. */
import { Menu, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsStore, PropsRenderSlots, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { createMenuStore } from './store.ts'
import type { MenuActionView } from './types.ts'
import { isContextMenuTrigger } from './external-trigger.ts'

/**
 * @param actions - plain presentation.
 * @param renderSlot - owner-authorized keyed icon renderer.
 * @returns Existing Menu entries.
 */
export function menuEntries(
  actions: readonly MenuActionView[],
  renderSlot: PropsRenderSlots<'contextMenu.icon'>['renderSlot'],
): MenuEntry[] {
  return actions.flatMap((action) => {
    const item: MenuEntry = { id: action.id, label: action.label,
      ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
      ...(action.danger === undefined ? {} : { danger: action.danger }),
      ...(action.icon === undefined ? {} : {
        icon: renderSlot('contextMenu.icon', { icon: action.icon }, { entryKey: action.icon.key }),
      }),
      ...(action.children === undefined ? {} : { submenu: menuEntries(action.children, renderSlot) }),
    }
    return action.separatorBefore ? [{ type: 'separator', id: `${action.id}:separator` }, item] : [item]
  })
}

/** Shared overlay callbacks (the shortcuts catalog arrives with that line's absorption). */
export interface MenuOverlayInjected {
  close: () => void
  returnFocus?: () => HTMLElement | null
  select: (id: string) => void
}
type Props = PropsStore<ReturnType<typeof createMenuStore>>
  & PropsRenderSlots<'contextMenu.content' | 'contextMenu.icon'> & InjectFace<MenuOverlayInjected> & PropsLocale<'contextMenu'>

/** @param props - registered state, target-specific legacy rows, and actions. @returns one menu and persistent feedback. */
export function MenuOverlay({ useStore, actions, renderSlot, close, select, returnFocus, t }: Props) {
  const { target, point, items, notice, occurrence, closing, replacing } = useStore(s => s)
  return <>
    <Menu key={occurrence} open={target !== null} anchor={null} portal autoFocus contextual returnFocus={returnFocus}
      submenuBackLabel={t('back')} isExternalTrigger={isContextMenuTrigger}
      exiting={closing ? replacing ? 'replace' : 'dismiss' : undefined}
      anchorPoint={point}
      items={menuEntries(items.filter(item => !item.afterContent), renderSlot)}
      footer={menuEntries(items.filter(item => item.afterContent), renderSlot)} onClose={close} onSelect={select}>
      {target !== null && renderSlot('contextMenu.content', { target, dismiss: close }, { entryKey: target.kind })}
    </Menu>
    {notice !== null && <Toast key={notice.id} text={notice.text}
      {...notice.action === undefined ? {} : { actions: [notice.action] }}
      {...notice.success ? { tone: 'success' as const } : {}} onDone={() => { actions.notify(null) }} />}
  </>
}
