/**
 * EffortButton: the composer's named effort seat
 * (`conversation.input.effort`), rendered directly right of the model
 * seat. It is the quick affordance over the SAME per-session directory the
 * model seat reads: the current model's declared levels with the effective
 * effort preselected, submitted through the same selectModel call — so a
 * pick here is exactly what the model seat's trigger shows next. The seat
 * renders nothing while the current model declares no reasoning (the model
 * seat's drilled pane owns that empty case); catalog loading and its retry
 * stay on the model seat too. A rejected selection announces through the
 * shared transient Toast anchored to the composer card.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import { effortChoicesOf, effortLabelOf, effectiveEffortOf, reasoningOf } from './effort.ts'
import css from './ModelSelect.module.css'

/**
 * Render the composer effort seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the level menu; nothing while the
 * current model declares no reasoning.
 */
export function EffortButton(
  { locked, available, directory, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const id = useId()

  const entry = reasoningOf(state)
  const reasoning = entry?.reasoning
  const effectiveEffort = effectiveEffortOf(state.current, reasoning)
  const effortLabel = effortLabelOf(effectiveEffort, reasoning, t)
  const effortChoices = useMemo(() => effortChoicesOf(reasoning, t), [reasoning, t])
  const busy = state.status === 'selecting'

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  // The quick affordance exists only when there is something to pick.
  if (!available || entry === undefined) return null

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: entry.current.provider,
      model: entry.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    void select(selection).then(settleSelection)
  }

  const triggerAria = t('effortButton.aria', { effort: effortLabel })

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          close(true)
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={effortLabel}
        disabled={locked}
        onClick={() => {
          if (open) close()
          else setOpen(true)
        }}
      >
        <span className={css.triggerLabel}>{effortLabel}</span>
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('menu.effort')}
          aria-busy={busy}
        >
          {effortChoices.map(level => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={effectiveEffort === level.effort}
              className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
              key={level.key}
              disabled={busy}
              onClick={() => { chooseEffort(level.effort) }}
            >
              <span className={css.optionCopy}>
                <span className={css.modelName}>{level.label}</span>
                {level.description !== undefined && (
                  <span className={css.description}>{level.description}</span>
                )}
              </span>
              <span className={css.check}>
                {effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
              </span>
            </button>
          ))}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
