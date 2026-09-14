/**
 * Effort derivation shared by the two effort affordances — the model seat's
 * drilled effort pane and the standalone effort button right of it. Both
 * render from the SAME per-session directory, so the label and rows they
 * show must come from one pure derivation.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from './directory.ts'


/** One dynamic effort row; undefined means preserve the provider default. */
export interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/** The reasoning metadata a directory model row may carry. */
export type ModelReasoning = NonNullable<ModelDirectoryState['groups'][number]['models'][number]['reasoning']>

/** The current selection paired with the reasoning its model declares. */
export interface ReasoningEntry {
  current: ModelSelection
  reasoning: ModelReasoning
}

/**
 * Find the current selection's reasoning metadata in the loaded groups.
 * @param state - the session's directory snapshot.
 * @returns the current selection and its model's reasoning, or undefined
 * when the host has no current selection or the model advertises none.
 */
export function reasoningOf(state: ModelDirectoryState): ReasoningEntry | undefined {
  if (state.current === null) return undefined
  const group = state.groups.find(candidate => candidate.id === state.current?.provider)
  const reasoning = group?.models.find(candidate => candidate.id === state.current?.model)?.reasoning
  return reasoning === undefined ? undefined : { current: state.current, reasoning }
}

/**
 * The effort the next assembled step carries: the session's explicit pick,
 * else the model's declared default, else the provider's own default.
 * @param current - the host-reported selection, or null before the first load.
 * @param reasoning - the current model's reasoning metadata, if any.
 * @returns the effective effort id, or undefined to send no effort.
 */
export function effectiveEffortOf(
  current: ModelSelection | null,
  reasoning: ModelReasoning | undefined,
): string | undefined {
  return current?.reasoningEffort ?? reasoning?.defaultEffort
}

/**
 * Spell an effort id as the user-facing label.
 * @param effective - the effective effort id.
 * @param reasoning - the current model's reasoning metadata, if any.
 * @param t - the model-namespace translate.
 * @returns undefined only while the model declares no reasoning at all.
 */
export function effortLabelOf(
  effective: string | undefined,
  reasoning: ModelReasoning | undefined,
  t: TranslateNS<'model'>,
): string | undefined {
  return reasoning === undefined
    ? undefined
    : effective === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effective)?.name ?? effective
}

/**
 * Build the selectable effort rows: the provider-default row only when the
 * model does not pin its own default, then one row per declared level.
 * @param reasoning - the current model's reasoning metadata, if any.
 * @param t - the model-namespace translate.
 * @returns the rows, empty while the model declares no reasoning.
 */
export function effortChoicesOf(
  reasoning: ModelReasoning | undefined,
  t: TranslateNS<'model'>,
): readonly EffortChoice[] {
  return reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map(effort => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ]
}
