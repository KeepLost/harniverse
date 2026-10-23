/**
 * One MCP server card: identity, live state badge, preset references, the
 * enable toggle, and the expandable tool inventory from the management
 * Remote.
 */

import { useState } from 'react'
import {
  Button, IconEditOutline16, IconRefreshOutline16, IconTrashOutline16, Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpServerRow } from './section-store.ts'
import type { McpLocaleKey } from './locales.ts'
import css from './McpSection.module.css'

/** Business actions one card drives. */
export interface ServerRowActions {
  /** Flip this row's enabled flag through the settings scope. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  /** Open the editor over this row. */
  edit: (id: string) => void
  /** Ask for delete confirmation for this row. */
  requestDelete: (id: string) => void
  /** Restart this row's shared connection through the management Remote. */
  restart: (id: string) => Promise<string | undefined>
}

/** Translator carrying the section's dictionary. */
export type ServerRowTranslate = (key: McpLocaleKey, params?: Record<string, unknown>) => string

/** One card's props. */
export interface ServerRowProps {
  /** The joined row this card renders. */
  row: McpServerRow
  /** Whether writes are accepted for the current principal. */
  writable: boolean
  /** Locale translator. */
  t: ServerRowTranslate
  /** Row actions. */
  actions: ServerRowActions
}

/** Classify a live state into the card's color band. */
function stateClass(state: string): string | undefined {
  if (state === 'connected') return css.stateConnected
  if (state === 'reconnecting' || state === 'connecting' || state === 'exhausted') return css.stateRetrying
  if (state === 'stopped' || state === 'disposed') return css.stateDown
  return css.stateIdle
}

/** One server card. */
export function ServerRow(props: ServerRowProps) {
  const { row, writable, t, actions } = props
  const [open, setOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const state = row.status?.state ?? (row.enabled ? 'connecting' : 'disabled')
  const label = t(`state.${state}`, row.status === undefined ? undefined : {
    failed: String(row.status.failedAttempts),
    max: String(row.status.maxAttempts),
  })
  const presetText = row.presets.length > 0
    ? t('row.presets', { names: row.presets.join(', ') })
    : t('row.presets.zero')
  const tools = row.status?.tools ?? []
  const toolsLabel = tools.length > 0 ? t('row.tools', { count: String(tools.length) }) : t('row.tools.zero')

  return (
    <article className={css.card}>
      <div className={css.cardTop}>
        <span className={css.cardName}>{row.serverName}</span>
        <span className={`${css.cardMeta} ${stateClass(state)}`}>{label}</span>
        {row.status?.connectedAtMs !== undefined && (
          <span className={css.cardMeta}>
            {t('state.since', { time: new Date(row.status.connectedAtMs).toLocaleTimeString() })}
          </span>
        )}
        {row.status?.lastErrorKind !== undefined && (
          <span className={css.cardMeta}>{t('state.errorKind', { kind: row.status.lastErrorKind })}</span>
        )}
        <span className={css.cardSpacer} />
        <label className={css.cardMeta}>
          <input
            type="checkbox"
            checked={row.enabled}
            disabled={!writable}
            onChange={(event) => { void actions.setEnabled(row.id, event.target.checked) }}
          />
          {row.enabled ? t('row.enabled') : t('row.disabled')}
        </label>
        <div className={css.cardActions}>
          <Button variant="ghost" size="sm" disabled={!writable} onClick={() => { actions.edit(row.id) }} aria-label={t('row.edit')}>
            <IconEditOutline16 size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!writable || !row.enabled || restarting}
            aria-label={t('row.restart')}
            onClick={() => {
              setRestarting(true)
              void actions.restart(row.id).finally(() => { setRestarting(false) })
            }}
          >
            <IconRefreshOutline16 size={16} />
          </Button>
          <Button variant="ghost" size="sm" disabled={!writable} aria-label={t('row.delete')} onClick={() => { actions.requestDelete(row.id) }}>
            <IconTrashOutline16 size={16} />
          </Button>
        </div>
      </div>
      <div className={css.cardMeta}>
        <span>{row.id}</span>
        <span>{row.transport}</span>
        {tools.length > 0
          ? (
            <Pill active={open} onClick={() => { setOpen(!open) }}>
              {toolsLabel}
            </Pill>
          )
          : <Pill>{toolsLabel}</Pill>}
      </div>
      <div className={css.presets}>{presetText}</div>
      {open && tools.length > 0 && (
        <div className={css.tools}>
          {tools.map(tool => (
            <div key={tool.name} className={css.toolRow}>
              <span className={css.toolName}>{tool.name}</span>
              {tool.description !== '' && <span className={css.toolDescription}>{tool.description}</span>}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}
