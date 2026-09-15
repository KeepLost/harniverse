// @vitest-environment jsdom
/**
 * Direct-prop tests for the capability declaration block: every write path
 * and parse path it owns, asserted on the patch channel it produces. The
 * mounted round-trips in provider-form/components specs cover the wiring into
 * cards; this file pins the block's own branch behaviour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelCapabilities } from '../src/client/ModelCapabilities.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

/**
 * Feed the patch channel back into the row, the way the list editor's rows
 * do: spread the patch and drop the keys it clears, so a controlled input
 * reads back what it just wrote.
 */
function applyPatch(current: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const cleared = new Set(Object.entries(next).filter(([, value]) => value === undefined).map(([key]) => key))
  return Object.fromEntries(Object.entries({ ...current, ...next }).filter(([key]) => !cleared.has(key)))
}

/** A stateful host so the block's controlled inputs observe their own writes. */
function Host(props: {
  initial: Record<string, unknown>
  api?: string | undefined
  onPatch: (next: Record<string, unknown>) => void
}) {
  const [model, setModel] = useState(props.initial)
  return (
    <ModelCapabilities
      model={model}
      patch={(next) => {
        props.onPatch(next)
        setModel(current => applyPatch(current, next))
      }}
      t={t}
      disabled={false}
      api={props.api}
    />
  )
}

/** Render one row's capability block over a captured patch channel. */
function mount(model: Record<string, unknown>, api?: string) {
  const patch = vi.fn()
  const view = render(<Host initial={model} api={api} onPatch={patch} />)
  return { patch, view }
}

/** The last patch's merged argument. */
function lastPatch(patch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return patch.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

describe('ModelCapabilities', () => {
  it('writes and clears the image declaration', () => {
    const { patch } = mount({})

    fireEvent.click(screen.getByLabelText(t('modelImageInput')))
    expect(lastPatch(patch)).toEqual({ input: ['text', 'image'] })

    fireEvent.click(screen.getByLabelText(t('modelImageInput')))
    expect(lastPatch(patch)).toEqual({ input: undefined })
  })

  it('declares the starter set when reasoning is checked and removes the declaration when unchecked', () => {
    const { patch } = mount({})

    fireEvent.click(screen.getByLabelText(t('modelReasoning')))
    expect(lastPatch(patch)).toEqual({ reasoningEfforts: { off: null, medium: 'medium', high: 'high' } })

    fireEvent.click(screen.getByLabelText(t('modelReasoning')))
    expect(lastPatch(patch)).toEqual({ reasoningEfforts: undefined, defaultReasoningEffort: undefined })
  })

  it('narrowing a level also drops a default that pointed at it', () => {
    const { patch } = mount({
      reasoningEfforts: { off: null, medium: 'medium' },
      defaultReasoningEffort: 'medium',
    })

    fireEvent.click(screen.getByLabelText('medium'))
    expect(patch).toHaveBeenCalledWith({ defaultReasoningEffort: undefined })
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: { off: null } })
  })

  it('checking a level writes its canonical spelling', () => {
    const { patch } = mount({ reasoningEfforts: { off: null } })
    fireEvent.click(screen.getByLabelText('xhigh'))
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: { off: null, xhigh: 'xhigh' } })
  })

  it('unchecking a level drops its wire spelling with it', () => {
    const { patch } = mount({ reasoningEfforts: { off: null, max: 'ultra' } })
    fireEvent.click(screen.getByLabelText('max'))
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: { off: null } })
    // Rechecking starts from the canonical spelling: the declaration, wire
    // value included, left with the checkbox.
    fireEvent.click(screen.getByLabelText('max'))
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: { off: null, max: 'max' } })
  })

  it('wire text lands verbatim, and empty text restores the canonical spelling', () => {
    const { patch } = mount({ reasoningEfforts: { off: null, high: 'high' } })

    fireEvent.change(screen.getByLabelText(`${t('modelEffortWire')} high`), { target: { value: 'ultra' } })
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: { off: null, high: 'ultra' } })

    fireEvent.change(screen.getByLabelText(`${t('modelEffortWire')} high`), { target: { value: '' } })
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: { off: null, high: 'high' } })

    fireEvent.change(screen.getByLabelText(`${t('modelEffortWire')} off`), { target: { value: 'none' } })
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: { off: 'none', high: 'high' } })

    fireEvent.change(screen.getByLabelText(`${t('modelEffortWire')} off`), { target: { value: '' } })
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: { off: null, high: 'high' } })
  })

  it('the default select writes levels, default, and unset', () => {
    const { patch } = mount({ reasoningEfforts: { off: null, high: 'high' } })
    const select = screen.getByLabelText(t('modelDefaultEffort'))

    fireEvent.change(select, { target: { value: 'high' } })
    expect(lastPatch(patch)).toEqual({ defaultReasoningEffort: 'high' })
    fireEvent.change(select, { target: { value: 'off' } })
    expect(lastPatch(patch)).toEqual({ defaultReasoningEffort: 'off' })
    fireEvent.change(select, { target: { value: 'default' } })
    expect(lastPatch(patch)).toEqual({ defaultReasoningEffort: 'default' })
    fireEvent.change(select, { target: { value: '' } })
    expect(lastPatch(patch)).toEqual({ defaultReasoningEffort: undefined })
  })

  it('the dispatch format lands on compat and leaving chat-template drops the kwargs', () => {
    const { patch } = mount({
      reasoningEfforts: { off: null, high: 'high' },
      compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } } },
    }, 'openai-completions')
    const select = screen.getByLabelText(t('modelThinkingFormat'))

    fireEvent.change(select, { target: { value: 'deepseek' } })
    expect(lastPatch(patch)).toEqual({ compat: { thinkingFormat: 'deepseek' } })

    fireEvent.change(select, { target: { value: 'chat-template' } })
    expect(lastPatch(patch)).toEqual({ compat: { thinkingFormat: 'chat-template' } })

    fireEvent.change(select, { target: { value: '' } })
    expect(lastPatch(patch)).toEqual({ compat: undefined })
  })

  it('unchecking the last level drops the declaration entirely', () => {
    const { patch } = mount({ reasoningEfforts: { medium: 'medium' } })

    fireEvent.click(screen.getByLabelText('medium'))
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: undefined })
  })

  it('checking off on a set without it declares the send-nothing spelling', () => {
    const { patch } = mount({ reasoningEfforts: { medium: 'medium' } })

    fireEvent.click(screen.getByLabelText('off'))
    expect(patch).toHaveBeenLastCalledWith({ reasoningEfforts: { off: null, medium: 'medium' } })
  })

  it('edits kwargs rows: naming, retyping the value, following the level, omitting, deleting', () => {
    const { patch } = mount({
      reasoningEfforts: { off: null, high: 'high' },
      compat: { thinkingFormat: 'chat-template' },
    }, 'openai-completions')

    fireEvent.click(screen.getByText(t('modelKwargAdd')))
    // The added row drafts unnamed, which is exactly the refusal the section
    // validator owns; the patch still carries it so the input keeps rendering.
    expect(lastPatch(patch)).toEqual({
      compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { '': { $var: 'thinking.enabled' } } },
    })

    fireEvent.change(screen.getByLabelText(`${t('modelKwargName')} 1`), { target: { value: 'enable_thinking' } })
    expect(lastPatch(patch)).toEqual({
      compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } } },
    })

    fireEvent.change(screen.getByLabelText(`${t('modelKwargKind')} 1`), { target: { value: 'thinking.effort' } })
    expect(lastPatch(patch)).toEqual({
      compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: { $var: 'thinking.effort' } } },
    })

    fireEvent.click(screen.getByLabelText(t('modelKwargOmitWhenOff')))
    expect(lastPatch(patch)).toEqual({
      compat: {
        thinkingFormat: 'chat-template',
        chatTemplateKwargs: { enable_thinking: { $var: 'thinking.effort', omitWhenOff: true } },
      },
    })
    fireEvent.click(screen.getByLabelText(t('modelKwargOmitWhenOff')))
    expect(lastPatch(patch)).toEqual({
      compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: { $var: 'thinking.effort' } } },
    })

    fireEvent.change(screen.getByLabelText(`${t('modelKwargKind')} 1`), { target: { value: 'literal' } })
    fireEvent.change(screen.getByLabelText(`${t('modelKwargValue')} 1`), { target: { value: 'yes' } })
    expect(lastPatch(patch)).toEqual({
      compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: 'yes' } },
    })

    // A second row keeps its own editor; touching it leaves the first alone.
    fireEvent.click(screen.getByText(t('modelKwargAdd')))
    fireEvent.change(screen.getByLabelText(`${t('modelKwargName')} 2`), { target: { value: 'budget' } })
    fireEvent.change(screen.getByLabelText(`${t('modelKwargKind')} 2`), { target: { value: 'thinking.effort' } })
    fireEvent.click(screen.getByLabelText(t('modelKwargOmitWhenOff')))
    expect(lastPatch(patch)).toEqual({
      compat: {
        thinkingFormat: 'chat-template',
        chatTemplateKwargs: {
          enable_thinking: 'yes',
          budget: { $var: 'thinking.effort', omitWhenOff: true },
        },
      },
    })
    fireEvent.change(screen.getByLabelText(`${t('modelKwargKind')} 2`), { target: { value: 'literal' } })
    fireEvent.change(screen.getByLabelText(`${t('modelKwargValue')} 2`), { target: { value: '4096' } })
    fireEvent.click(screen.getAllByText(t('removeModel')).at(-1) as HTMLElement)
    expect(lastPatch(patch)).toEqual({
      compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: 'yes' } },
    })

    // Deleting the last row drops the kwargs field with it.
    fireEvent.click(screen.getByText(t('removeModel')))
    expect(lastPatch(patch)).toEqual({ compat: { thinkingFormat: 'chat-template' } })
  })

  it('parses stored literal and variable kwargs back into their row editors', () => {
    mount({
      reasoningEfforts: { off: null, high: 'high' },
      compat: {
        thinkingFormat: 'chat-template',
        chatTemplateKwargs: {
          budget: 4096,
          label: 'deep',
          flag: true,
          absent: null,
          switch: { $var: 'thinking.enabled', omitWhenOff: true },
          level: { $var: 'thinking.effort' },
        },
      },
    }, 'openai-completions')

    // Numbers, strings, booleans, and absent values round-trip as literal
    // text; the variables select their kind, and the omit checkbox appears
    // per variable row.
    expect(screen.getByLabelText<HTMLInputElement>(`${t('modelKwargValue')} 1`).value).toBe('4096')
    expect(screen.getByLabelText<HTMLInputElement>(`${t('modelKwargValue')} 2`).value).toBe('deep')
    expect(screen.getByLabelText<HTMLInputElement>(`${t('modelKwargValue')} 3`).value).toBe('true')
    expect(screen.getByLabelText<HTMLInputElement>(`${t('modelKwargValue')} 4`).value).toBe('')
    expect(screen.getByLabelText<HTMLSelectElement>(`${t('modelKwargKind')} 5`).value).toBe('thinking.enabled')
    expect(screen.getByLabelText<HTMLSelectElement>(`${t('modelKwargKind')} 6`).value).toBe('thinking.effort')
    const omitBoxes = screen.getAllByLabelText<HTMLInputElement>(t('modelKwargOmitWhenOff'))
    expect(omitBoxes.map(box => box.checked)).toEqual([true, false])
  })

  it('keeps dispatch controls off a protocol whose reasoning lives in the protocol', () => {
    mount({ reasoningEfforts: { off: null, high: 'high' }, compat: { thinkingFormat: 'deepseek' } }, 'anthropic-messages')

    expect(screen.queryByLabelText(t('modelThinkingFormat'))).toBeNull()
    expect(screen.queryByText(t('modelKwargAdd'))).toBeNull()
  })

  it('hides the effort editor while reasoning is undeclared', () => {
    mount({})

    expect(screen.queryByLabelText('off')).toBeNull()
    expect(screen.queryByLabelText(t('modelDefaultEffort'))).toBeNull()
  })
})
