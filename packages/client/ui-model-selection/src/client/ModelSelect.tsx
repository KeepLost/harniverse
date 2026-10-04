/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Model catalogs above four entries show search, which retains focus while
 * ↑/↓ cycle the highlighted result; Enter and Tab accept it. Model names
 * match a case-insensitive ordered subsequence within each provider group
 * (prefix, alignment score, then catalog order); groups keep their catalog
 * order and empty ones hide. Provider headings paint their background only
 * while pinned by scrolling. Data and submission ride the SAME per-session
 * ModelDirectory as the /model popup; exact-model reasoning metadata and
 * the selected effort come from the Host rather than a client-owned
 * vocabulary. A rejected selection announces through the shared transient
 * Toast anchored to the composer card; the in-menu strip with Retry
 * remains the catalog-load surface.
 */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconCloseFill14, IconWarningOutline16, Input, MenuGroup, observeStickyMenuGroups, rankByName, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import { effortChoicesOf, effortLabelOf, effectiveEffortOf } from './effort.ts'
import css from './ModelSelect.module.css'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'profile' | 'route' | 'model' | 'effort'

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, selectProfile, selectRoute, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  // Catalogs above four entries search; the query ranks each provider
  // group's models in place (group order is the catalog's own) and hides
  // the groups it empties.
  const showSearch = choices.length > 4
  const filteredGroups = useMemo(() => state.groups.map(group => ({
    ...group, models: rankByName(group.models, showSearch ? query.trim() : ''),
  })).filter(group => group.models.length > 0), [state.groups, query, showSearch])
  const visibleModels = useMemo(() => filteredGroups.flatMap(group =>
    group.models.map(model => ({ provider: group.id, model: model.id }))), [filteredGroups])
  const currentVisibleIndex = visibleModels.findIndex(model =>
    model.provider === state.current?.provider && model.model === state.current.model)
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = effectiveEffortOf(state.current, reasoning)
  const effortLabel = effortLabelOf(effectiveEffort, reasoning, t)
  const effortChoices = useMemo(() => effortChoicesOf(reasoning, t), [reasoning, t])
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // Mount-time load resolves the trigger label; every open refreshes.
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  // A catalog that shrinks below the search threshold drops its query and
  // highlight, so a stale filter never silently empties a small list.
  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery('')
      setHighlightedIndex(null)
    }
  }, [showSearch])

  // The drilled model pane takes the keyboard on its search field; the
  // unmounted cell leaves focus on <body> otherwise.
  useEffect(() => {
    if (open && pane === 'model' && showSearch) searchRef.current?.focus()
  }, [open, pane, showSearch])

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [available, open, pane, filteredGroups])

  useLayoutEffect(() => {
    if (open && pane === 'model' && activeModelIndex >= 0) {
      itemRefs.current[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, pane, activeModelIndex, visibleModels])

  if (!available) return null

  const show = (): void => {
    setPane('root')
    setQuery('')
    setHighlightedIndex(null)
    setOpen(true)
    reload()
  }

  /** Drill into a pane; the model list always starts from the full catalog. */
  const drill = (next: Pane): void => {
    if (next === 'model') {
      setQuery('')
      setHighlightedIndex(null)
    }
    setPane(next)
  }

  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root') setPane('root')
      else close(true)
      return
    }
    if (!open) return
    if (pane === 'model' && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!busy && visibleModels.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setHighlightedIndex((activeModelIndex + direction + visibleModels.length) % visibleModels.length)
        searchRef.current?.focus()
      }
      return
    }
    if (pane === 'model' && showSearch && event.target instanceof HTMLInputElement
      && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
      if (event.key === 'Tab' && visibleModels.length === 0) return
      event.preventDefault()
      const highlighted = visibleModels[activeModelIndex]
      if (!busy && highlighted !== undefined) choose(highlighted)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseProfile = (profileId: string): void => {
    if (state.profile?.id === profileId) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void (selectProfile?.(profileId) ?? Promise.resolve(false)).then(settleSelection)
  }

  const chooseRoute = (routeId: string): void => {
    if (state.target?.kind === 'route' && state.target.route === routeId) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void (selectRoute?.(routeId) ?? Promise.resolve(false)).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  let modelIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role={pane === 'model' ? 'group' : 'menu'}
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              {state.profile != null && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('profile') }}>
                  <span className={css.cellLabel}>{t('menu.profile')}</span>
                  <span className={css.cellValue}>{state.profile.name}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              )}
              {(state.routes?.length ?? 0) > 0 && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('route') }}>
                  <span className={css.cellLabel}>{t('menu.route')}</span>
                  <span className={css.cellValue}>{state.target?.kind === 'route' ? state.target.route : t('menu.model')}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              )}
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('model') }}>
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
              {reasoning !== undefined && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              )}
            </>
          )}

          {pane === 'profile' && (
            <div className={clsx(css.groups, 'scrollable')}>
              {(state.profiles ?? []).length === 0
                ? <div className={css.empty}>{t('empty.profiles')}</div>
                : (state.profiles ?? []).map(profile => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={state.profile?.id === profile.id}
                    className={clsx(css.option, state.profile?.id === profile.id && css.selected)}
                    key={profile.id}
                    disabled={busy}
                    onClick={() => { chooseProfile(profile.id) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{profile.name}</span>
                      {profile.description === undefined ? null : <span className={css.description}>{profile.description}</span>}
                    </span>
                    <span className={css.check}>{state.profile?.id === profile.id ? <IconCheckOutline16 /> : null}</span>
                  </button>
                ))}
            </div>
          )}

          {pane === 'route' && (
            <div className={clsx(css.groups, 'scrollable')}>
              {(state.routes ?? []).length === 0
                ? <div className={css.empty}>{t('empty.routes')}</div>
                : (state.routes ?? []).map((route) => {
                  const selected = state.target?.kind === 'route' && state.target.route === route.id
                  return (
                    <button
                      ref={itemRef()}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={clsx(css.option, selected && css.selected)}
                      key={route.id}
                      disabled={busy}
                      onClick={() => { chooseRoute(route.id) }}
                    >
                      <span className={css.optionCopy}>
                        <span className={css.modelName}>{route.name ?? route.id}</span>
                        <span className={css.description}>{route.targets.map(target => `${target.provider}/${target.model}`).join(' → ')}</span>
                      </span>
                      <span className={css.check}>{selected ? <IconCheckOutline16 /> : null}</span>
                    </button>
                  )
                })}
            </div>
          )}

          {pane === 'model' && (
            <>
              {showSearch && <div className={css.searchRow}>
                <Input
                  ref={searchRef}
                  className={clsx(css.search, query !== '' && css.searchWithQuery)}
                  type="text"
                  role="searchbox"
                  aria-label={t('search.placeholder')}
                  aria-controls={`${id}-models`}
                  aria-activedescendant={activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`}
                  placeholder={t('search.placeholder')}
                  value={query}
                  readOnly={busy}
                  onChange={(event) => { changeQuery(event.target.value) }}
                />
                {query !== '' && (
                  <button
                    type="button"
                    className={css.searchClear}
                    aria-label={t('search.clear')}
                    disabled={busy}
                    onClick={() => {
                      changeQuery('')
                      searchRef.current?.focus()
                    }}
                  >
                    <IconCloseFill14 />
                  </button>
                )}
              </div>}
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div
                ref={groupsRef}
                id={`${id}-models`}
                className={clsx(css.groups, 'scrollable')}
                role="menu"
                aria-label={t('menu.model')}
                hidden={filteredGroups.length === 0}
              >
                {filteredGroups.map((group) => {
                  return (
                    <MenuGroup key={group.id} label={group.name}>
                      {group.models.map((model) => {
                        const index = modelIndex++
                        const selected = state.current?.provider === group.id && state.current.model === model.id
                        return (
                          <button
                            ref={itemRef()}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            id={`${id}-model-${index}`}
                            tabIndex={showSearch ? -1 : undefined}
                            onFocus={showSearch ? () => { setHighlightedIndex(index) } : undefined}
                            data-highlighted={showSearch && index === activeModelIndex ? '' : undefined}
                            onMouseMove={showSearch && !busy && index !== activeModelIndex
                              ? () => { setHighlightedIndex(index) }
                              : undefined}
                            className={clsx(
                              css.option, selected && css.selected, showSearch && index === activeModelIndex && css.optionActive,
                            )}
                            key={model.id}
                            title={model.name}
                            disabled={busy}
                            onClick={() => { choose({ provider: group.id, model: model.id }) }}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.modelName}>{model.name}</span>
                              {model.description !== undefined && (
                                <span className={css.description}>{model.description}</span>
                              )}
                            </span>
                            <span className={css.check}>
                              {selected ? <IconCheckOutline16 /> : null}
                            </span>
                          </button>
                        )
                      })}
                    </MenuGroup>
                  )
                })}
              </div>
              {state.status === 'ready' && filteredGroups.length === 0 && (
                <div className={css.empty} role="status">{t(choices.length === 0 ? 'empty.models' : 'search.empty')}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
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
            </>
          )}
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
