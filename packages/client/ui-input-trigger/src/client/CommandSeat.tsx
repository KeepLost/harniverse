/**
 * Command-menu launcher: occupies the composer's named
 * `conversation.input.commands` seat with the tool row's plus button. The
 * toggle aims a synthetic '/' hit through this session's controller (same
 * pipeline as typing '/'); the launcher store drives the expanded state.
 * The owner bar contributes its disable state, its focus keeper, and the
 * click-time textarea/machine context (see CommandToggleContext).
 */
import type { MouseEvent } from 'react'
import { IconPlusOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CommandSeat.module.css'
import type { CommandSeatInjected, CommandToggleContext } from './slots.ts'

/** Owner share from the composer bar (mirrors ui-conversation's CommandSeatOwnerProps). */
export interface CommandSeatOwnerShare {
  /** Session-removed lock (the bar's chrome disable state). */
  locked: boolean
  /** Mousedown focus keeper (button presses must not steal textarea focus). */
  keepFocus: (event: MouseEvent<HTMLButtonElement>) => void
  /** Snapshot the bar-side trigger context, or undefined without a textarea. */
  captureContext: () => CommandToggleContext | undefined
}

/** Full commands-seat props: injected face (hooks bound) & owner share & locale seat. */
export type CommandSeatProps =
  InjectFace<CommandSeatInjected>
  & CommandSeatOwnerShare
  & PropsLocale<'slash.menu'>

/**
 * Render the commands seat entry.
 * @param props - the toggle and launcher state through the inject face;
 * `locked`, `keepFocus`, and `captureContext` from the owner bar; `t` the locale seat.
 */
export function CommandSeat({ locked, keepFocus, captureContext, toggle, useLauncher, t }: CommandSeatProps) {
  const open = useLauncher(source => source === 'command')
  return (
    <Tooltip label={t('command.launcher')} side="top" delayMs={500}>
      <button
        type="button"
        className={css.launcher}
        aria-label={t('command.launcher')}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={locked}
        onMouseDown={keepFocus}
        onClick={() => {
          const context = captureContext()
          if (context !== undefined) toggle(context)
        }}
      >
        <IconPlusOutline16 size={14} />
      </button>
    </Tooltip>
  )
}
