/**
 * Statistics view: a totals header plus a turn table whose rows expand into
 * per-step facts (context, cache, TTFT, model/decode timing, speed, tool
 * accounting, retries) read from the `stats` conversation snapshot.
 */

import { useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  StatsCompactionFacts, StatsStepMetrics, StatsTotals, StatsTrigger, StatsTurnRow,
} from './stats-contract.ts'
import { EMPTY_STATS_SNAPSHOT } from './stats-contract.ts'
import { formatCount, formatMs, formatPercent, formatTps } from './stats-format.ts'
import type { StatsKey } from './locales.ts'
import css from './stats.module.css'

/** Inject face the plugin's slot registration hands to this view. */
export interface StatsViewInjected {
  readonly loadOlder: () => Promise<boolean>
}

const CLOSE_KEYS: ReadonlySet<string> = new Set([
  'completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted',
])

/** Turn-table column count, shared by header, turn, step, and compaction rows. */
const COLUMNS = 14

/**
 * Map one close kind to its dictionary key, falling back to the raw kind.
 * @param closeKind - `turn/end` reason kind.
 * @returns the locale key, or null for ordinary completions.
 */
function closeKey(closeKind: string | null): StatsKey | null {
  if (closeKind === null || closeKind === 'completed') return null
  return CLOSE_KEYS.has(closeKind) ? `close.${closeKind}` as StatsKey : null
}

/** Total context tokens one step's usage implies (uncached input plus both cache counts). */
function stepContext(step: StatsStepMetrics): number | null {
  if (step.usage === null) return null
  return step.usage.inputTokens + (step.usage.cacheReadTokens ?? 0) + (step.usage.cacheWriteTokens ?? 0)
}

function stepTtft(step: StatsStepMetrics): number | null {
  return step.firstTokenTime !== null && step.startTime !== null
    ? step.firstTokenTime - step.startTime
    : null
}

function stepModel(step: StatsStepMetrics): number | null {
  return step.messageTime !== null && step.startTime !== null
    ? step.messageTime - step.startTime
    : null
}

function stepDecode(step: StatsStepMetrics): number | null {
  return step.messageTime !== null && step.firstTokenTime !== null
    ? step.messageTime - step.firstTokenTime
    : null
}

/** Peak (last reported) context of a turn's steps. */
function turnContext(row: StatsTurnRow): number | null {
  for (let index = row.steps.length - 1; index >= 0; index -= 1) {
    const step = row.steps[index]
    /* v8 ignore next 2 -- the descending index is bounded by the array it came from. */
    if (step === undefined) continue
    const context = stepContext(step)
    if (context !== null) return context
  }
  return null
}

/** First step's TTFT, or null while the turn has no timed step. */
function turnTtft(row: StatsTurnRow): number | null {
  const first = row.steps[0]
  return first === undefined ? null : stepTtft(first)
}

/**
 * Render the statistics conversation view.
 * @param props - slot runtime shares, the injected load-older callback, and the bound translator.
 * @returns the view element tree.
 */
export function StatsView({
  useSession, loadOlder, t,
}: ConvViewProps & InjectFace<StatsViewInjected> & PropsLocale<'ui-stats'>) {
  const snapshot = useSession(session => session.views.get('stats') ?? EMPTY_STATS_SNAPSHOT)
  const loading = useSession(session => session.openState === 'loading')
  const loadingOlder = useSession(session => session.loadingOlder)
  const hasMore = useSession(session => session.hasMore)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const { rows, totals } = snapshot

  const toggle = (turn: number): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }

  if (loading) {
    return <div className={css.root}>{t('state.loading')}</div>
  }
  if (rows.length === 0) {
    return <div className={css.root}>{t('state.empty')}</div>
  }

  return (
    <div className={css.root}>
      <div className={css.totals}>
        <span className={css.totalsCaption}>{t('totals.caption')}</span>
        <span>{t('totals.turns')} {totals.turns}</span>
        <span>{t('totals.steps')} {totals.steps}</span>
        <span>{t('totals.model')} {formatMs(totals.llmMs)}</span>
        <span>{t('totals.tool')} {formatMs(totals.toolMs)}</span>
        <span>{t('totals.ttft')} {formatMs(totals.ttftSteps === 0 ? null : totals.ttftMs / totals.ttftSteps)}</span>
        <span>{t('totals.tps')} {formatTps(totals.decodeTokens === 0 ? null : totals.decodeTokens, totals.decodeMs === 0 ? null : totals.decodeMs)}</span>
        <span>{t('totals.output')} {formatCount(totals.outputTokens)}</span>
        <span>{t('totals.cacheHit')} {cacheHit(totals)}</span>
      </div>
      {hasMore
        ? <button type="button" className={css.loadOlder} disabled={loadingOlder} onClick={() => { void loadOlder() }}>
          {loadingOlder ? t('state.loading') : t('controls.loadOlder')}
        </button>
        : null}
      <table className={css.table}>
        <thead>
          <tr>
            <th aria-label={t('col.turn')} />
            <th scope="col">{t('col.turn')}</th>
            <th scope="col">{t('col.trigger')}</th>
            <th scope="col" className={css.num}>{t('col.steps')}</th>
            <th scope="col" className={css.num}>{t('col.context')}</th>
            <th scope="col" className={css.num}>{t('col.output')}</th>
            <th scope="col" className={css.num}>{t('col.ttft')}</th>
            <th scope="col" className={css.num}>{t('col.model')}</th>
            <th scope="col" className={css.num}>{t('col.decode')}</th>
            <th scope="col" className={css.num}>{t('col.tps')}</th>
            <th scope="col" className={css.num}>{t('col.tool')}</th>
            <th scope="col" className={css.num}>{t('col.cache')}</th>
            <th scope="col" className={css.num}>{t('col.retries')}</th>
            <th scope="col" className={css.num}>{t('col.errors')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => row.kind === 'turn'
            ? <TurnRows key={`turn-${row.turn}`} row={row} expanded={expanded.has(row.turn)} onToggle={toggle} t={t} />
            : <CompactionRow key={`compaction-${row.facts.anchorSeq}`} facts={row.facts} t={t} />)}
        </tbody>
      </table>
    </div>
  )
}

/** Cache-hit ratio over the whole window: cached input over total input. */
function cacheHit(totals: StatsTotals): string {
  return formatPercent(
    totals.cacheReadTokens === 0 ? null : totals.cacheReadTokens,
    totals.cacheReadTokens + totals.inputTokens,
  )
}

function TriggerCell({ trigger, t }: { trigger: StatsTrigger | null; t: PropsLocale<'ui-stats'>['t'] }) {
  if (trigger === null) return <span className={css.muted}>—</span>
  const known: StatsKey = trigger.sourceKind === 'user'
    ? 'trigger.user'
    : trigger.sourceKind === 'plugin' ? 'trigger.plugin' : 'trigger.unknown'
  const label = trigger.sourceKind === 'user' || trigger.sourceKind === 'plugin'
    ? t(known)
    : trigger.sourceKind
  const detail = trigger.plugin !== null ? `:${trigger.plugin}` : ''
  const counts: string[] = []
  if (trigger.images > 0) counts.push(`${trigger.images} ${t('trigger.images')}`)
  if (trigger.files - trigger.images > 0) counts.push(`${trigger.files - trigger.images} ${t('trigger.files')}`)
  const title = trigger.summary ?? trigger.preview ?? label
  return (
    <span className={css.trigger} title={title}>
      <span className={css.triggerKind}>{label}{detail}</span>
      {counts.length > 0 ? <span className={css.pill}>{counts.join(' · ')}</span> : null}
    </span>
  )
}

function TurnRows({
  row, expanded, onToggle, t,
}: {
  row: StatsTurnRow
  expanded: boolean
  onToggle: (turn: number) => void
  t: PropsLocale<'ui-stats'>['t']
}) {
  const cache = turnCache(row)
  const retries = row.steps.reduce((sum, step) => sum + step.retries, 0)
  const errors = row.steps.reduce((sum, step) => sum + step.calls.filter(call => call.error).length, 0)
  const badge = closeKey(row.closeKind)
  return (
    <>
      <tr className={css.turnRow}>
        <td>
          <button
            type="button"
            className={css.expand}
            aria-expanded={expanded}
            aria-label={expanded ? t('controls.collapse') : t('controls.expand')}
            onClick={() => { onToggle(row.turn) }}
          >
            {expanded ? '▾' : '▸'}
          </button>
        </td>
        <td className={css.turnCell}>{row.turn}{badge !== null ? <span className={css.badge}>{t(badge)}</span> : null}</td>
        <td><TriggerCell trigger={row.trigger} t={t} /></td>
        <td className={css.num}>{row.steps.length}</td>
        <td className={css.num}>{formatCount(turnContext(row))}</td>
        <td className={css.num}>{formatCount(turnOutput(row))}</td>
        <td className={css.num}>{formatMs(turnTtft(row))}</td>
        <td className={css.num}>{formatMs(turnModel(row))}</td>
        <td className={css.num}>{formatMs(turnDecode(row))}</td>
        <td className={css.num}>{formatTps(turnOutput(row) === 0 ? null : turnOutput(row), turnDecode(row))}</td>
        <td className={css.num}>{formatMs(turnTool(row))}</td>
        <td className={css.num}>{formatPercent(cache.read === 0 ? null : cache.read, cache.read + cache.input)}</td>
        <td className={css.num}>{retries}</td>
        <td className={css.num}>{errors}</td>
      </tr>
      {expanded ? row.steps.map(step => <StepRow key={step.anchorSeq} step={step} t={t} />) : null}
      {expanded ? row.compactions.map(facts => (
        <tr key={`compaction-${facts.anchorSeq}`} className={css.compactionDetail}>
          <td />
          <td colSpan={COLUMNS - 2} className={css.muted}>{compactionText(facts, t)}</td>
        </tr>
      )) : null}
    </>
  )
}

function StepRow({ step, t }: { step: StatsStepMetrics; t: PropsLocale<'ui-stats'>['t'] }) {
  const running = !step.closed && step.messageTime === null
  const toolCounts = new Map<string, number>()
  for (const call of step.calls) toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1)
  const pills = [...toolCounts.entries()].map(([name, count]) => `${name}×${count}`).join(' ')
  const usage = step.usage
  const cacheText = usage === null
    ? '—'
    : (usage.cacheReadTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0
      ? `${formatCount(usage.cacheReadTokens ?? 0)}·${formatCount(usage.cacheWriteTokens ?? 0)} ${formatPercent(usage.cacheReadTokens ?? null, (usage.cacheReadTokens ?? 0) + usage.inputTokens)}`
      : '—'
  return (
    <tr className={css.stepRow} title={step.answer ?? undefined}>
      <td />
      <td className={css.stepCell}>
        {`#${step.step}`}
        {running ? <span className={css.badge}>{t('state.running')}</span> : null}
        {step.interrupted ? <span className={css.badge}>{t('state.interrupted')}</span> : null}
      </td>
      <td className={css.calls} colSpan={2}>{pills}{step.toolOpen > 0 ? ` · ${step.toolOpen} ${t('state.openTool')}` : ''}</td>
      <td className={css.num}>{formatCount(stepContext(step))}</td>
      <td className={css.num}>{formatCount(step.usage?.outputTokens ?? null)}</td>
      <td className={css.num}>{formatMs(stepTtft(step))}</td>
      <td className={css.num}>{formatMs(stepModel(step))}</td>
      <td className={css.num}>{formatMs(stepDecode(step))}</td>
      <td className={css.num}>{formatTps(step.usage?.outputTokens ?? null, stepDecode(step))}</td>
      <td className={css.num}>{formatMs(step.toolMs)}</td>
      <td className={css.num}>{cacheText}</td>
      <td className={css.num}>{step.retries}</td>
      <td className={css.num}>{step.calls.filter(call => call.error).length}</td>
    </tr>
  )
}

function CompactionRow({ facts, t }: { facts: StatsCompactionFacts; t: PropsLocale<'ui-stats'>['t'] }) {
  return (
    <tr className={css.compactionRow}>
      <td />
      <td colSpan={COLUMNS - 2} className={css.muted}>{compactionText(facts, t)}</td>
    </tr>
  )
}

function compactionText(facts: StatsCompactionFacts, t: PropsLocale<'ui-stats'>['t']): string {
  const parts = [t('compaction.title')]
  if (facts.provider !== null) parts.push(facts.provider)
  if (facts.model !== null) parts.push(facts.model)
  if (facts.usage !== null) parts.push(`${formatCount(facts.usage.inputTokens)}→${formatCount(facts.usage.outputTokens)}`)
  if (facts.shadowedTokenCount !== null) parts.push(`${t('compaction.shadowed')} ${formatCount(facts.shadowedTokenCount)}`)
  parts.push(formatMs(facts.endedAt === null ? null : facts.endedAt - facts.startedAt))
  if (facts.error !== null) parts.push(facts.error)
  return parts.join(' · ')
}

function turnModel(row: StatsTurnRow): number {
  let total = 0
  for (const step of row.steps) total += stepModel(step) ?? 0
  return total
}

function turnDecode(row: StatsTurnRow): number {
  let total = 0
  for (const step of row.steps) total += stepDecode(step) ?? 0
  return total
}

function turnTool(row: StatsTurnRow): number {
  let total = 0
  for (const step of row.steps) total += step.toolMs
  return total
}

function turnOutput(row: StatsTurnRow): number {
  let total = 0
  for (const step of row.steps) total += step.usage?.outputTokens ?? 0
  return total
}

function turnCache(row: StatsTurnRow): { read: number; input: number } {
  let read = 0
  let input = 0
  for (const step of row.steps) {
    if (step.usage === null) continue
    read += step.usage.cacheReadTokens ?? 0
    input += step.usage.inputTokens
  }
  return { read, input }
}
