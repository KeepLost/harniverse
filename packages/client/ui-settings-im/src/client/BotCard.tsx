/**
 * One bot card: platform badge, inline-editable alias, identity text, status
 * (a dot plus words, never color alone) with the last check time, and a
 * collapse chevron. The expanded body holds the workspace, model, and preset
 * overrides and the action row (check, retry, disable/enable, remove with a
 * confirmation).
 */
import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  Button, IconCheckOutline16, IconCloseOutline16, IconEditOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatBotView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ImInjected } from './controller.ts'
import { BotSettings, type WorkspaceChoice } from './BotSettings.tsx'
import { errorText, formatClock, maskIdentity, statusText, statusTone, type ImTranslate } from './format.ts'
import { PlatformBadge } from './PlatformBadge.tsx'
import type { BotNote, ImState } from './stores.ts'
import css from './BotCard.module.css'

/** The operation verbs one card calls, each addressed by bot id. */
export type BotFace = Pick<ImInjected,
  'rename' | 'setEnabled' | 'check' | 'retry' | 'remove' | 'setWorkspace' | 'pickWorkspace' | 'setModel' | 'setPreset'>

/** Props of one bot card. */
export interface BotCardProps {
  /** The bot. */
  bot: ChatBotView
  /** Display name of the bot's platform, for the badge fallback. */
  platformLabel: string
  /** Whether the body is shown. */
  expanded: boolean
  /** Pending operations of this bot (`update`, `check`, `retry`, `remove`). */
  busy: readonly string[]
  /** Latest operation outcome of this bot. */
  note: BotNote | undefined
  /** Whether the removal confirmation is open. */
  confirming: boolean
  /** Registered workspaces offered by the directory chooser. */
  workspaces: readonly WorkspaceChoice[]
  /** The model catalog state. */
  models: ImState['models']
  /** The agent preset roster state. */
  presets: ImState['presets']
  /** The operation verbs. */
  face: BotFace
  /** Expand or collapse the card. */
  onToggle: () => void
  /** Open or withdraw the removal confirmation. */
  onAskRemove: (asking: boolean) => void
  /** Bound translator. */
  t: ImTranslate
}

/** Down-pointing chevron; the toggle rotates it when open. */
function Chevron() {
  return (
    <svg className={css.chevronIcon} width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 5 4 4 4-4" />
    </svg>
  )
}

/** The alias with its pencil, or the inline editor while renaming. */
function AliasLine({ alias, rename, t }: { alias: string; rename: (alias: string) => void; t: ImTranslate }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(alias)
  const commit = (): void => {
    const next = draft.trim()
    if (next !== '' && next !== alias) rename(next)
    setEditing(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      // The settings panel closes on a document-level Escape; this one only cancels the rename.
      event.stopPropagation()
      setEditing(false)
    }
  }
  if (!editing) {
    return (
      <div className={css.aliasLine}>
        <span className={css.alias}>{alias}</span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('card.rename', { alias })}
          onClick={() => {
            setDraft(alias)
            setEditing(true)
          }}
        >
          <IconEditOutline16 size={14} />
        </button>
      </div>
    )
  }
  return (
    <div className={css.aliasLine}>
      <input
        className={css.aliasInput}
        aria-label={t('card.aliasLabel')}
        value={draft}
        autoFocus
        onChange={(event) => { setDraft(event.target.value) }}
        onKeyDown={onKeyDown}
      />
      <button type="button" className={css.iconButton} aria-label={t('card.aliasSave')} onClick={commit}>
        <IconCheckOutline16 size={14} />
      </button>
      <button type="button" className={css.iconButton} aria-label={t('card.aliasCancel')} onClick={() => { setEditing(false) }}>
        <IconCloseOutline16 size={14} />
      </button>
    </div>
  )
}

/** The latest operation outcome of the bot. */
function Note({ note, t }: { note: BotNote; t: ImTranslate }) {
  if (note.kind === 'check' && note.ok) {
    return <p className={css.note} role="status">{t('check.ok', { time: formatClock(note.checkedAt) })}</p>
  }
  const text = note.kind === 'check'
    ? note.message === undefined ? t('check.failBare') : t('check.fail', { message: note.message })
    : errorText(t, note.error)
  return <p className={`${css.note} ${css.noteError}`} role="alert">{text}</p>
}

/**
 * Render one bot card.
 * @param props - the bot, its view state, the catalogs, the verbs, and the translator.
 * @returns the card list item.
 */
export function BotCard({
  bot, platformLabel, expanded, busy, note, confirming, workspaces, models, presets, face, onToggle, onAskRemove, t,
}: BotCardProps) {
  const bodyId = useId()
  const pending = busy.length > 0
  const removing = busy.includes('remove')
  const { pickWorkspace } = face
  const name = bot.identity.displayName
  return (
    <li className={css.card} data-state={bot.state}>
      <div className={css.header}>
        <PlatformBadge platform={bot.platform} label={platformLabel} />
        <div className={css.identity}>
          <AliasLine alias={bot.alias} rename={(alias) => { void face.rename(bot.id, alias) }} t={t} />
          <p className={css.identityLine} aria-label={t('card.identity')}>
            <code className={css.identityCode}>{maskIdentity(bot.identity.botId)}</code>
            {name === '' || name === bot.identity.botId ? null : ` · ${name}`}
          </p>
        </div>
        <div className={css.status}>
          <div role="status">
            <span className={css.statusLine}>
              <span className={css.dot} data-tone={statusTone(bot.state)} aria-hidden="true" />
              {statusText(t, bot)}
            </span>
          </div>
          <span className={css.checked}>
            {bot.checkedAt === undefined ? t('status.unchecked') : t('status.checked', { time: formatClock(bot.checkedAt) })}
          </span>
        </div>
        <button
          type="button"
          className={css.chevron}
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          aria-label={t(expanded ? 'card.collapse' : 'card.expand', { alias: bot.alias })}
          onClick={onToggle}
        >
          <Chevron />
        </button>
      </div>
      {note === undefined ? null : <Note note={note} t={t} />}
      {expanded
        ? (
          <div id={bodyId} className={css.body}>
            <BotSettings
              bot={bot}
              workspaces={workspaces}
              models={models}
              presets={presets}
              busy={busy.includes('update')}
              setWorkspace={(workspace) => { void face.setWorkspace(bot.id, workspace) }}
              setModel={(model) => { void face.setModel(bot.id, model) }}
              setPreset={(agentProfile) => { void face.setPreset(bot.id, agentProfile) }}
              t={t}
              {...pickWorkspace === undefined ? {} : { pickWorkspace: () => { void pickWorkspace(bot.id) } }}
            />
            <div className={css.actions}>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => { void face.check(bot.id) }}>
                {busy.includes('check') ? t('action.checking') : t('action.check')}
              </Button>
              {bot.state === 'online' || bot.state === 'disabled'
                ? null
                : (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => { void face.retry(bot.id) }}>
                    {busy.includes('retry') ? t('action.retrying') : t('action.retry')}
                  </Button>
                )}
              <Button size="sm" variant="outline" disabled={pending} onClick={() => { void face.setEnabled(bot.id, !bot.enabled) }}>
                {bot.enabled ? t('action.disable') : t('action.enable')}
              </Button>
              <Button size="sm" variant="outline" className={css.danger} disabled={pending} onClick={() => { onAskRemove(true) }}>
                {t('action.remove')}
              </Button>
            </div>
            {confirming
              ? (
                <div className={css.confirm}>
                  <p className={css.confirmText} role="alert">{t('action.removeConfirm', { alias: bot.alias })}</p>
                  <div className={css.confirmActions}>
                    <Button size="sm" variant="outline" className={css.danger} disabled={removing} onClick={() => { void face.remove(bot.id) }}>
                      {removing ? t('action.removing') : t('action.removeYes')}
                    </Button>
                    <Button size="sm" variant="outline" autoFocus disabled={removing} onClick={() => { onAskRemove(false) }}>
                      {t('action.removeNo')}
                    </Button>
                  </div>
                </div>
              )
              : null}
          </div>
        )
        : null}
    </li>
  )
}
