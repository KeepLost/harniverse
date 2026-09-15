import { describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { effortChoicesOf, effortLabelOf, effectiveEffortOf, type ModelReasoning } from '../src/client/effort.ts'

const t: TranslateNS<'model'> = (key, params) => {
  const table: Record<string, string> = {
    'effort.providerDefault': 'Default',
    'menu.effort': 'Effort',
  }
  const value = table[key] ?? key
  return params === undefined ? value : Object.entries(params).reduce(
    (text, [name, token]) => text.replaceAll(`{${name}}`, String(token)), value)
}

const withDefault: ModelReasoning = {
  defaultEffort: 'high',
  efforts: [
    { id: 'high', name: 'High' },
    { id: 'medium', name: 'Medium', description: 'balanced' },
  ],
}

describe('effort derivation', () => {
  it('the explicit session pick wins over the model default, and no fact sends no effort', () => {
    expect(effectiveEffortOf({ provider: 'p', model: 'm', reasoningEffort: 'medium' }, withDefault)).toBe('medium')
    expect(effectiveEffortOf({ provider: 'p', model: 'm' }, withDefault)).toBe('high')
    expect(effectiveEffortOf(null, undefined)).toBeUndefined()
  })

  it('the label is undefined without reasoning, spells an unknown id verbatim, and names Default for no effort', () => {
    expect(effortLabelOf('high', undefined, t)).toBeUndefined()
    expect(effortLabelOf('exotic', withDefault, t)).toBe('exotic')
    expect(effortLabelOf('high', withDefault, t)).toBe('High')
    expect(effortLabelOf(undefined, withDefault, t)).toBe('Default')
  })

  it('rows stay empty without reasoning, pin the model default by omission, and carry descriptions', () => {
    expect(effortChoicesOf(undefined, t)).toEqual([])
    const rows = effortChoicesOf(withDefault, t)
    expect(rows).toEqual([
      { key: 'effort:high', effort: 'high', label: 'High' },
      { key: 'effort:medium', effort: 'medium', label: 'Medium', description: 'balanced' },
    ])
    const free = { efforts: [{ id: 'low', name: 'Low' }] } as ModelReasoning
    expect(effortChoicesOf(free, t)).toEqual([
      { key: 'provider-default', effort: undefined, label: 'Default' },
      { key: 'effort:low', effort: 'low', label: 'Low' },
    ])
  })
})
