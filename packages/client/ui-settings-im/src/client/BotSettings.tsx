/**
 * The expanded body of a bot card: the bot's workspace, model and thinking
 * effort (efforts come from the chosen model), and agent preset. An absent
 * override follows the host default, and every select offers that choice.
 */
import { useId, useState } from 'react'
import type { ChatBotModelView, ChatBotView, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { ImTranslate } from './format.ts'
import type { ImState } from './stores.ts'
import controls from './controls.module.css'
import css from './BotSettings.module.css'

/** One workspace the host has registered. */
export interface WorkspaceChoice {
  /** Absolute directory path, the value written to the bot. */
  path: string
  /** Workspace title. */
  title: string
}

type ModelSelection = ChatBotModelView
type ModelReasoning = NonNullable<ModelProviderGroup['models'][number]['reasoning']>

/** Props of the bot settings body. */
export interface BotSettingsProps {
  /** The bot whose overrides are shown. */
  bot: ChatBotView
  /** Registered workspaces offered by the directory chooser. */
  workspaces: readonly WorkspaceChoice[]
  /** The model catalog state. */
  models: ImState['models']
  /** The agent preset roster state. */
  presets: ImState['presets']
  /** Whether an update of this bot is in flight. */
  busy: boolean
  /** Set the workspace; null follows the default. */
  setWorkspace: (workspace: string | null) => void
  /** Pick the workspace with the native chooser; absent without one. */
  pickWorkspace?: () => void
  /** Set the model route and effort; null follows the default. */
  setModel: (model: ModelSelection | null) => void
  /** Set the agent preset; null follows the default. */
  setPreset: (agentProfile: string | null) => void
  /** Bound translator. */
  t: ImTranslate
}

/** One catalog model flattened for the select. */
interface ModelChoice {
  value: string
  provider: string
  model: string
  reasoning: ModelReasoning | undefined
}

/** Option value of a provider/model pair. */
const modelValue = (provider: string, model: string): string => JSON.stringify([provider, model])

/** The workspace row: the current directory and the chooser behind "选择目录". */
function WorkspaceRow({ bot, workspaces, busy, setWorkspace, pickWorkspace, t }: Pick<BotSettingsProps,
  'bot' | 'workspaces' | 'busy' | 'setWorkspace' | 'pickWorkspace' | 't'>) {
  const titleId = useId()
  const registeredId = useId()
  const pathId = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const current = bot.settings.workspace
  const listed = current === undefined || workspaces.some(workspace => workspace.path === current)
  return (
    <div className={css.group} role="group" aria-labelledby={titleId}>
      <span id={titleId} className={css.groupTitle}>{t('workspace.title')}</span>
      <div className={css.workspaceLine}>
        {current === undefined ? <span className={css.follow}>{t('workspace.follow')}</span> : <code className={css.path}>{current}</code>}
        <button
          type="button"
          className={controls.textButton}
          aria-expanded={open}
          disabled={busy}
          onClick={() => { setOpen(visible => !visible) }}
        >
          {t('workspace.choose')}
        </button>
      </div>
      {open
        ? (
          <div className={css.chooser}>
            <div className={controls.field}>
              <label className={controls.label} htmlFor={registeredId}>{t('workspace.registered')}</label>
              <select
                id={registeredId}
                className={controls.select}
                value={current ?? ''}
                disabled={busy}
                onChange={(event) => { setWorkspace(event.target.value === '' ? null : event.target.value) }}
              >
                <option value="">{t('workspace.follow')}</option>
                {workspaces.map(workspace => (
                  <option key={workspace.path} value={workspace.path}>{`${workspace.title} — ${workspace.path}`}</option>
                ))}
                {listed ? null : <option value={current}>{current}</option>}
              </select>
            </div>
            <div className={controls.field}>
              <label className={controls.label} htmlFor={pathId}>{t('workspace.pathLabel')}</label>
              <div className={css.chooserRow}>
                <input
                  id={pathId}
                  className={`${controls.input} ${controls.mono}`}
                  value={draft}
                  placeholder={t('workspace.pathPlaceholder')}
                  disabled={busy}
                  spellCheck={false}
                  onChange={(event) => { setDraft(event.target.value) }}
                />
                <button
                  type="button"
                  className={controls.textButton}
                  disabled={busy || draft.trim() === ''}
                  onClick={() => { setWorkspace(draft.trim()) }}
                >
                  {t('workspace.apply')}
                </button>
                {pickWorkspace === undefined
                  ? null
                  : (
                    <button type="button" className={controls.textButton} disabled={busy} onClick={pickWorkspace}>
                      {t('workspace.browse')}
                    </button>
                  )}
              </div>
            </div>
          </div>
        )
        : null}
    </div>
  )
}

/** The model and thinking-effort rows over one provider catalog. */
function ModelRows({ bot, models, busy, setModel, t }: Pick<BotSettingsProps, 'bot' | 'models' | 'busy' | 'setModel' | 't'>) {
  const modelId = useId()
  const effortId = useId()
  const groupId = useId()
  const selection = bot.settings.model
  const choices: ModelChoice[] = models.groups.flatMap((group: ModelProviderGroup) => group.models.map(model => ({
    value: modelValue(group.id, model.id),
    provider: group.id,
    model: model.id,
    reasoning: model.reasoning,
  })))
  const currentValue = selection === undefined ? '' : modelValue(selection.provider, selection.model)
  const known = choices.find(choice => choice.value === currentValue)
  const efforts = known?.reasoning?.efforts ?? []
  const effortValue = selection?.reasoningEffort ?? ''
  const effortListed = effortValue === '' || efforts.some(effort => effort.id === effortValue)
  const effortHint = selection === undefined
    ? t('model.effortNeedsModel')
    : known?.reasoning === undefined ? t('model.effortUnsupported') : null
  return (
    <fieldset className={css.group} aria-labelledby={groupId}>
      <legend id={groupId} className={css.groupTitle}>{t('model.group')}</legend>
      <div className={css.row}>
        <label className={css.rowLabel} htmlFor={modelId}>{t('model.model')}</label>
        <div className={css.rowBody}>
          <select
            id={modelId}
            className={controls.select}
            value={currentValue}
            disabled={busy}
            onChange={(event) => {
              if (event.target.value === '') {
                setModel(null)
                return
              }
              const choice = choices.find(entry => entry.value === event.target.value)
              // The unlisted current model is not in `choices`; re-picking it changes nothing.
              if (choice !== undefined) setModel({ provider: choice.provider, model: choice.model })
            }}
          >
            <option value="">{t('model.follow')}</option>
            {models.groups.map(group => (
              <optgroup key={group.id} label={group.name}>
                {group.models.map(model => (
                  <option key={model.id} value={modelValue(group.id, model.id)}>{model.name}</option>
                ))}
              </optgroup>
            ))}
            {selection === undefined || known !== undefined
              ? null
              : <option value={currentValue}>{t('model.unlisted', { name: `${selection.provider} / ${selection.model}` })}</option>}
          </select>
          {models.status === 'error' ? <p className={controls.hint}>{t('model.catalogError')}</p> : null}
        </div>
      </div>
      <div className={css.row}>
        <label className={css.rowLabel} htmlFor={effortId}>{t('model.effort')}</label>
        <div className={css.rowBody}>
          <select
            id={effortId}
            className={controls.select}
            value={effortValue}
            disabled={busy || known?.reasoning === undefined}
            onChange={(event) => {
              if (selection === undefined) return
              const { provider, model } = selection
              setModel(event.target.value === ''
                ? { provider, model }
                : { provider, model, reasoningEffort: event.target.value })
            }}
          >
            <option value="">{t('model.follow')}</option>
            {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
            {effortListed ? null : <option value={effortValue}>{effortValue}</option>}
          </select>
          {effortHint === null ? null : <p className={controls.hint}>{effortHint}</p>}
        </div>
      </div>
    </fieldset>
  )
}

/** The agent preset row. */
function PresetRow({ bot, presets, busy, setPreset, t }: Pick<BotSettingsProps, 'bot' | 'presets' | 'busy' | 'setPreset' | 't'>) {
  const id = useId()
  const current = bot.settings.agentProfile
  return (
    <div className={css.row}>
      <label className={css.rowLabel} htmlFor={id}>{t('preset.title')}</label>
      <div className={css.rowBody}>
        <select
          id={id}
          className={controls.select}
          value={current ?? ''}
          disabled={busy}
          onChange={(event) => { setPreset(event.target.value === '' ? null : event.target.value) }}
        >
          <option value="">{t('preset.follow')}</option>
          {presets.options.map(option => <option key={option.id} value={option.id}>{option.name ?? option.id}</option>)}
          {current === undefined || presets.options.some(option => option.id === current)
            ? null
            : <option value={current}>{t('model.unlisted', { name: current })}</option>}
        </select>
        {presets.status === 'error' ? <p className={controls.hint}>{t('preset.catalogError')}</p> : null}
      </div>
    </div>
  )
}

/**
 * Render the expanded settings of one bot.
 * @param props - the bot, the catalogs, the registered workspaces, and the setters.
 * @returns the settings body.
 */
export function BotSettings({
  bot, workspaces, models, presets, busy, setWorkspace, pickWorkspace, setModel, setPreset, t,
}: BotSettingsProps) {
  return (
    <div className={css.settings}>
      <WorkspaceRow
        bot={bot}
        workspaces={workspaces}
        busy={busy}
        setWorkspace={setWorkspace}
        t={t}
        {...pickWorkspace === undefined ? {} : { pickWorkspace }}
      />
      <ModelRows bot={bot} models={models} busy={busy} setModel={setModel} t={t} />
      <PresetRow bot={bot} presets={presets} busy={busy} setPreset={setPreset} t={t} />
    </div>
  )
}
