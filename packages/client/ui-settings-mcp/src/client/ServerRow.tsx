/**
 * One MCP server card: identity, live state badge, preset references, the
 * enable toggle, the expandable tool inventory from the management Remote,
 * and the OAuth line of a server that authenticates through a grant.
 */

import { useState } from 'react'
import {
  Button, IconEditOutline16, IconPlayOutline16, IconRefreshOutline16, IconTrashOutline16, Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpProbeView, McpServerRow } from './section-store.ts'
import type { McpManagementAttempt, McpManagementAuthorization } from '@deepseek-ai/dsh-mcp-user-config/types'
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
  /** Probe this row's configuration without touching the live fleet. */
  probe: (id: string) => Promise<void>
  /** Begin or join the OAuth authorization of this row's server. */
  authorize: (id: string) => Promise<string | undefined>
  /** Cancel this row's pending OAuth authorization. */
  cancelAuthorization: (id: string) => Promise<void>
  /** Delete this row's stored OAuth grant. */
  signOut: (id: string) => Promise<void>
}

/** Probe view for one card; undefined carries no probe surface. */
export interface ServerRowProbe {
  /** The row's current probe view. */
  view: McpProbeView | undefined
}

/** Translator carrying the section's dictionary. */
export type ServerRowTranslate = (key: McpLocaleKey, params?: Record<string, unknown>) => string

/** One card's props. */
export interface ServerRowProps {
  /** The joined row this card renders. */
  row: McpServerRow
  /** Whether writes are accepted for the current principal. */
  writable: boolean
  /** The row's current probe view, if any. */
  probe: McpProbeView | undefined
  /** Locale translator. */
  t: ServerRowTranslate
  /** Row actions. */
  actions: ServerRowActions
  /** The authorization page while this row's attempt waits for the browser. */
  authorizationUrl?: string | undefined
  /** Why the Host refused this row's latest authorization request. */
  authorizationError?: string | undefined
}

/** Classify a live state into the card's color band. */
function stateClass(state: string): string | undefined {
  if (state === 'connected') return css.stateConnected
  if (state === 'reconnecting' || state === 'connecting' || state === 'exhausted' || state === 'waiting-authorization') return css.stateRetrying
  if (state === 'stopped' || state === 'disposed') return css.stateDown
  return css.stateIdle
}

/** Whether an authorization attempt can still complete. */
function isPendingAttempt(attempt: McpManagementAttempt | undefined): attempt is McpManagementAttempt & { phase: 'starting' | 'waiting-browser' | 'exchanging' | 'committing' } {
  return attempt?.phase === 'starting' || attempt?.phase === 'waiting-browser' || attempt?.phase === 'exchanging' || attempt?.phase === 'committing'
}

/** The settled outcome an attempt reports; `authorized` needs no line beside the grant state. */
function attemptOutcome(attempt: McpManagementAttempt | undefined, t: ServerRowTranslate): string | undefined {
  if (attempt?.phase === 'failed') return t('oauth.attempt.failed')
  if (attempt?.phase === 'cancelled') return t('oauth.attempt.cancelled')
  return undefined
}

/** The OAuth line's props: the card's row and the shares its actions need. */
interface OAuthLineProps {
  row: McpServerRow
  writable: boolean
  url: string | undefined
  error: string | undefined
  t: ServerRowTranslate
  actions: ServerRowActions
}

/**
 * The OAuth line of a card: the grant state, the attempt phase, and the
 * actions that move them. Absent for a server that carries no OAuth state.
 */
function OAuthLine(props: OAuthLineProps) {
  const { row, writable, url, error, t, actions } = props
  const authorization: McpManagementAuthorization | undefined = row.status?.authorization
  if (authorization === undefined) return null
  const attempt = row.status?.attempt
  const pending = isPendingAttempt(attempt)
  const outcome = attemptOutcome(attempt, t)
  return (
    <div className={css.cardMeta}>
      {authorization.state === 'authorized'
        ? <span className={css.stateConnected}>{t('oauth.authorized')}</span>
        : <span className={css.stateRetrying}>{t('oauth.waiting', { reason: t(`oauth.reason.${authorization.reason}`) })}</span>}
      {pending && <span>{t(`oauth.attempt.${attempt.phase}`)}</span>}
      {outcome !== undefined && <span className={attempt?.phase === 'failed' ? css.stateDown : undefined}>{outcome}</span>}
      {error !== undefined && <span className={css.formError}>{t('oauth.failed', { message: error })}</span>}
      <span className={css.cardSpacer} />
      <div className={css.cardActions}>
        {/* The authorization page is a plain link: opening it is the user's own navigation, never a scripted popup. */}
        {url !== undefined && (
          <a className={css.oauthLink} href={url} target="_blank" rel="noopener noreferrer">{t('oauth.open')}</a>
        )}
        {pending
          ? (
            <Button variant="ghost" size="sm" disabled={!writable} onClick={() => { void actions.cancelAuthorization(row.id) }}>
              {t('oauth.cancel')}
            </Button>
          )
          : authorization.state === 'waiting-authorization' && (
            <Button variant="outline" size="sm" disabled={!writable} onClick={() => { void actions.authorize(row.id) }}>
              {t('oauth.authorize')}
            </Button>
          )}
        <Button variant="ghost" size="sm" disabled={!writable || pending} onClick={() => { void actions.signOut(row.id) }}>
          {t('oauth.signOut')}
        </Button>
      </div>
    </div>
  )
}

/** One server card. */
export function ServerRow(props: ServerRowProps) {
  const { row, writable, probe, t, actions } = props
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
        {row.registered && <span className={css.cardMeta}>{t('row.registered')}</span>}
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
        {/* A plugin-registered server exists for its plugin's lifetime: the
            toggle and the settings-owned actions stay off, the fleet actions stay on. */}
        {!row.registered && (
          <label className={css.cardMeta}>
            <input
              type="checkbox"
              checked={row.enabled}
              disabled={!writable}
              onChange={(event) => { void actions.setEnabled(row.id, event.target.checked) }}
            />
            {row.enabled ? t('row.enabled') : t('row.disabled')}
          </label>
        )}
        <div className={css.cardActions}>
          {!row.registered && (
            <Button variant="ghost" size="sm" disabled={!writable} onClick={() => { actions.edit(row.id) }} aria-label={t('row.edit')}>
              <IconEditOutline16 size={16} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!writable || probe?.phase === 'probing'}
            aria-label={t('row.probe')}
            onClick={() => { void actions.probe(row.id) }}
          >
            <IconPlayOutline16 size={16} />
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
          {!row.registered && (
            <Button variant="ghost" size="sm" disabled={!writable} aria-label={t('row.delete')} onClick={() => { actions.requestDelete(row.id) }}>
              <IconTrashOutline16 size={16} />
            </Button>
          )}
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
      {probe !== undefined && (
        <div className={css.cardMeta}>
          {probe.phase === 'probing'
            ? <span>{t('row.probing')}</span>
            : probe.ok
              ? <span>{t('row.probeOk', probe.summary)}</span>
              : <span>{t('row.probeFail', probe.summary)}</span>}
        </div>
      )}
      <OAuthLine
        row={row}
        writable={writable}
        url={props.authorizationUrl}
        error={props.authorizationError}
        t={t}
        actions={actions}
      />
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
